/**
 * GRM FLAP backend
 * -----------------
 * Flow: Telegram Bot -> Mini App (index.html) -> this server -> daily/weekly/monthly
 * leaderboard -> FLAP wallet withdrawal.
 *
 * Playing does NOT credit currency. Score is points only, used for leaderboards.
 * FLAP coins (100 FLAP = $1) live on the wallet and are not earned by flying.
 *
 * The client NEVER gets to tell the server "my score is X". The server
 * replays physics.js from seed + flapLog + reviveLog.
 */
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const P = require('./physics.js');
const { verifyInitData } = require('./telegramAuth.js');
const store = require('./store.js');

try {
  const art = require('./art-assets.js');
  const dir = path.join(__dirname, 'img');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, b64] of Object.entries(art)) {
    if (typeof b64 === 'string' && b64.length) {
      fs.writeFileSync(path.join(dir, name), Buffer.from(b64, 'base64'));
    }
  }
  console.log('FLAPY art ready at', dir);
} catch (err) {
  console.error('FLAPY art materialize failed:', err.message || err);
}

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(__dirname));

const sessionNames = new Map();

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ALLOW_INSECURE_DEV = process.env.ALLOW_INSECURE_DEV === 'true';
const INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60;

function authenticate(initData) {
  if (ALLOW_INSECURE_DEV && !initData) {
    return { id: 'dev-user', first_name: 'Dev', username: 'dev_tester' };
  }
  const result = verifyInitData(initData, BOT_TOKEN, INIT_DATA_MAX_AGE_SECONDS);
  if (!result.ok) return null;
  return result.user;
}

function displayName(user) {
  return user.username ? '@' + user.username : (user.first_name || 'Player');
}

function ranksFor(userId) {
  const day = store.getUserRank(userId, 'day');
  const week = store.getUserRank(userId, 'week');
  const month = store.getUserRank(userId, 'month');
  return {
    day: day ? day.rank : null,
    week: week ? week.rank : null,
    month: month ? month.rank : null,
  };
}

app.post('/api/start-session', (req, res) => {
  const user = authenticate(req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });

  if (!store.allowRequest('start:' + user.id, 12, 60 * 1000)) {
    return res.status(429).json({ error: 'too many session starts, slow down' });
  }

  store.trackUser(String(user.id));

  const sessionId = crypto.randomBytes(16).toString('hex');
  const seed = crypto.randomInt(1, 2 ** 31 - 1);
  store.createSession(sessionId, String(user.id), seed);
  sessionNames.set(sessionId, displayName(user));

  res.json({ sessionId, seed, physicsVersion: P.VERSION, maxRevives: P.MAX_REVIVES });
});

app.post('/api/submit-score', (req, res) => {
  const { sessionId, flapLog, totalSteps, clientScore, reviveLog } = req.body || {};

  if (!sessionId || !Array.isArray(flapLog) || !Number.isFinite(totalSteps)) {
    return res.status(400).json({ error: 'malformed submission' });
  }
  if (flapLog.length > 20000 || totalSteps > P.MAX_STEPS_PER_SESSION) {
    return res.status(400).json({ error: 'submission too large' });
  }
  const revives = Array.isArray(reviveLog) ? reviveLog.slice(0, 10) : [];

  const session = store.getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'unknown or expired session' });
  if (session.used) return res.status(409).json({ error: 'session already submitted' });

  const elapsedRealMs = Date.now() - session.startedAt;
  const revivesClaimed = Math.min(revives.length, P.MAX_REVIVES);
  const REVIVE_ALLOWANCE_MS = 5000;
  const claimedMs = totalSteps * (P.STEP * 1000);
  const TOLERANCE = 1.15;
  if (claimedMs > (elapsedRealMs + revivesClaimed * REVIVE_ALLOWANCE_MS) * TOLERANCE + 2000) {
    store.consumeSession(sessionId);
    return res.status(400).json({ error: 'submission rejected: implausible timing' });
  }

  const allowedSteps = Math.min(
    totalSteps,
    Math.ceil(((elapsedRealMs + revivesClaimed * REVIVE_ALLOWANCE_MS) / 1000) / P.STEP) + 5
  );
  const replay = P.simulate(session.seed, flapLog, allowedSteps, revives);

  store.consumeSession(sessionId);

  const verifiedScore = replay.score;
  const name = sessionNames.get(sessionId) || 'Player';
  sessionNames.delete(sessionId);
  store.submitPeriodScores(session.userId, name, verifiedScore);
  const allTimeBest = store.updateAllTimeBest(session.userId, name, verifiedScore);
  const ranks = ranksFor(session.userId);
  store.recordRun();

  res.json({
    score: verifiedScore,
    clientScoreMismatch: verifiedScore !== clientScore,
    best: allTimeBest,
    allTimeBest,
    rank: ranks.week,
    ranks,
    weekKey: store.currentWeekKey(),
    dayKey: store.currentDayKey(),
    monthKey: store.currentMonthKey(),
    revivesUsed: replay.revivesUsed,
    flapBalance: store.getBalance(session.userId),
  });
});

app.get('/api/leaderboard', (req, res) => {
  const period = ['day', 'week', 'month'].includes(req.query.period) ? req.query.period : 'week';
  const { ranked, periodKey } = store.getLeaderboard(period, 50);
  const top = ranked.slice(0, 50).map(e => ({ rank: e.rank, name: e.name, score: e.score }));

  let me = null;
  if (req.query.uid) {
    const mine = store.getUserRank(String(req.query.uid), period);
    if (mine) me = { rank: mine.rank, score: mine.score };
  }

  res.json({
    period,
    periodKey,
    dayKey: store.currentDayKey(),
    weekKey: store.currentWeekKey(),
    monthKey: store.currentMonthKey(),
    entries: top,
    me,
  });
});

app.post('/api/profile', (req, res) => {
  const user = authenticate(req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });

  const userId = String(user.id);
  const ranks = ranksFor(userId);

  res.json({
    name: displayName(user),
    best: store.getAllTimeBest(userId),
    flapBalance: store.getBalance(userId),
    depositAddress: process.env.DEPOSIT_TON_ADDRESS || '',
    rank: ranks.week,
    ranks,
    dayKey: store.currentDayKey(),
    weekKey: store.currentWeekKey(),
    monthKey: store.currentMonthKey(),
  });
});

const TON_ADDRESS_RE = /^(?:[A-Za-z0-9_-]{48}|-?\d:[0-9a-fA-F]{64})$/;

app.post('/api/withdraw', (req, res) => {
  const user = authenticate(req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });

  const userId = String(user.id);
  if (!store.allowRequest('withdraw:' + userId, 5, 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'too many withdrawal requests, try again later' });
  }

  const address = String(req.body.address || '').trim();
  const amount = Number(req.body.amount);

  if (!TON_ADDRESS_RE.test(address)) {
    return res.status(400).json({ error: 'invalid TON address format' });
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'invalid amount' });
  }

  const result = store.requestWithdrawal(userId, displayName(user), address, amount);
  if (!result.ok) return res.status(400).json({ error: result.error });

  res.json({ ok: true, requestId: result.request.id, flapBalance: result.balance, balance: result.balance });
});

// TADS widget "reward URL" / postback. Must return 200 or TADS may retry.
function tadsReward(req, res) {
  console.log('TADS reward postback', req.method, req.query, req.body || {});
  res.status(200).json({ ok: true });
}
app.get('/api/tads-reward', tadsReward);
app.post('/api/tads-reward', tadsReward);

app.post('/api/deposit', (req, res) => {
  const user = authenticate(req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });

  const userId = String(user.id);
  if (!store.allowRequest('deposit:' + userId, 8, 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'too many top-up requests, try again later' });
  }

  const amount = Number(req.body.amount);
  const txHash = String(req.body.txHash || '').trim();
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'invalid amount' });
  }
  if (txHash.length < 8 || txHash.length > 128) {
    return res.status(400).json({ error: 'invalid transaction hash' });
  }

  const result = store.requestDeposit(userId, displayName(user), amount, txHash);
  if (!result.ok) return res.status(400).json({ error: result.error });

  res.json({
    ok: true,
    requestId: result.request.id,
    status: result.request.status,
    amount,
    usd: amount / 100,
    flapBalance: store.getBalance(userId),
  });
});

function requireAdmin(req, res) {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  return true;
}

app.get('/internal/withdrawals', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ withdrawals: store.listWithdrawals(req.query.status) });
});

app.post('/internal/withdrawals/:id/paid', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const w = store.markWithdrawalPaid(Number(req.params.id));
  if (!w) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true, withdrawal: w });
});

app.get('/internal/deposits', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ deposits: store.listDeposits(req.query.status) });
});

app.post('/internal/deposits/:id/approve', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const result = store.approveDeposit(Number(req.params.id));
  if (!result) return res.status(404).json({ error: 'not found or already handled' });
  res.json({ ok: true, deposit: result.deposit, flapBalance: result.balance });
});

app.post('/internal/deposits/:id/reject', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const d = store.rejectDeposit(Number(req.params.id));
  if (!d) return res.status(404).json({ error: 'not found or already handled' });
  res.json({ ok: true, deposit: d });
});

app.get('/internal/stats', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const runStats = store.getRunStats();
  res.json(Object.assign({
    totalUsers: store.getTotalUsers(),
    activePlayers: store.getActivePlayers(),
    totalRuns: runStats.totalRuns,
  }, store.persistInfo()));
});

app.get('/internal/backup', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const snap = store.getSnapshot();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="flapy-backup.json"');
  res.send(JSON.stringify(snap, null, 2));
});

app.post('/internal/backup', (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!req.body || typeof req.body !== 'object' || !req.body.periodBoards) {
    return res.status(400).json({ error: 'invalid backup file' });
  }
  const info = store.importSnapshot(req.body);
  res.json({ ok: true, restored: info });
});

const { runWeeklyRewardJob } = require('./rewards.js');
app.post('/internal/run-weekly-rewards', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const result = runWeeklyRewardJob(store);
  res.json(result);
});

const PORT = process.env.PORT || 3000;
const start = store.ready || Promise.resolve();
start.then(() => {
  app.listen(PORT, () => {
    const info = store.persistInfo();
    console.log(`GRM FLAP backend listening on :${PORT}`);
    console.log('Persist backend:', info.backend, info.redis ? '(Upstash Redis)' : store.dataFile);
  });
}).catch((err) => {
  console.error('Failed to load store:', err);
  process.exit(1);
});

module.exports = app;
