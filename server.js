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
const INDEX_FILE = path.join(__dirname, 'index.html');
app.get(['/', '/index.html'], (req, res, next) => {
  if (fs.existsSync(INDEX_FILE)) return res.sendFile(INDEX_FILE);
  next();
});
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

function startParamFrom(req) {
  let p = String((req.body && (req.body.startParam || req.body.ref)) || '').trim();
  if (p) return p;
  const initData = String((req.body && req.body.initData) || '');
  try {
    p = new URLSearchParams(initData).get('start_param') || '';
  } catch (e) {}
  return p;
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
  store.attachReferral(String(user.id), displayName(user), startParamFrom(req));

  const sessionId = crypto.randomBytes(16).toString('hex');
  const seed = crypto.randomInt(1, 2 ** 31 - 1);
  store.createSession(sessionId, String(user.id), seed);
  sessionNames.set(sessionId, displayName(user));

  res.json({ sessionId, seed, physicsVersion: P.VERSION, maxRevives: P.MAX_REVIVES });
});

function replaySession(sessionId, flapLog, totalSteps, reviveLog, opts) {
  opts = opts || {};
  if (!sessionId || !Array.isArray(flapLog) || !Number.isFinite(totalSteps)) {
    return { ok: false, status: 400, error: 'malformed submission' };
  }
  if (flapLog.length > 20000 || totalSteps > P.MAX_STEPS_PER_SESSION) {
    return { ok: false, status: 400, error: 'submission too large' };
  }
  const session = store.getSession(sessionId);
  if (!session) return { ok: false, status: 404, error: 'unknown or expired session' };
  if (session.used) return { ok: false, status: 409, error: 'session already submitted' };
  if (opts.userId && String(session.userId) !== String(opts.userId)) {
    return { ok: false, status: 403, error: 'session belongs to another user' };
  }

  const revives = opts.allowRevives && Array.isArray(reviveLog) ? reviveLog.slice(0, 10) : [];
  const elapsedRealMs = Date.now() - session.startedAt;
  const revivesClaimed = Math.min(revives.length, P.MAX_REVIVES);
  const REVIVE_ALLOWANCE_MS = 5000;
  const claimedMs = totalSteps * (P.STEP * 1000);
  const TOLERANCE = 1.15;
  if (claimedMs > (elapsedRealMs + revivesClaimed * REVIVE_ALLOWANCE_MS) * TOLERANCE + 2000) {
    store.consumeSession(sessionId);
    return { ok: false, status: 400, error: 'submission rejected: implausible timing' };
  }

  const allowedSteps = Math.min(
    totalSteps,
    Math.ceil(((elapsedRealMs + revivesClaimed * REVIVE_ALLOWANCE_MS) / 1000) / P.STEP) + 5
  );
  const replay = P.simulate(session.seed, flapLog, allowedSteps, revives);
  store.consumeSession(sessionId);
  return { ok: true, session, replay };
}

app.post('/api/submit-score', (req, res) => {
  const { sessionId, flapLog, totalSteps, clientScore, reviveLog } = req.body || {};

  const verified = replaySession(sessionId, flapLog, totalSteps, reviveLog, { allowRevives: true });
  if (!verified.ok) return res.status(verified.status).json({ error: verified.error });

  const session = verified.session;
  const replay = verified.replay;

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
    referralBoard: period === 'day' ? store.getReferralLeaderboardDay(20) : [],
  });
});

app.post('/api/profile', (req, res) => {
  const user = authenticate(req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });

  const userId = String(user.id);
  const ranks = ranksFor(userId);

  store.trackUser(userId);
  store.attachReferral(userId, displayName(user), req.body.startParam || req.body.ref || '');
  const refInfo = store.getReferralInfo(userId, displayName(user));
  const appLink = (process.env.TELEGRAM_APP_LINK || process.env.MINI_APP_SHARE || 'https://t.me/FlapyGameBot/directlink').trim().replace(/\/$/, '');
  const referralLink = appLink
    ? (appLink + (appLink.indexOf('?') >= 0 ? '&' : '?') + 'startapp=' + encodeURIComponent(refInfo.code))
    : ('https://t.me/share/url?url=' + encodeURIComponent(refInfo.code));
  res.json({
    name: displayName(user),
    best: store.getAllTimeBest(userId),
    flapBalance: store.getBalance(userId),
    cBalance: store.getCBalance(userId),
    depositAddress: process.env.DEPOSIT_TON_ADDRESS || 'UQAKc6kclPQL-oe_QeXv-JZ98jI_WBFaLYkWikjWPx3WFqEd',
    rank: ranks.week,
    ranks,
    dayKey: store.currentDayKey(),
    weekKey: store.currentWeekKey(),
    monthKey: store.currentMonthKey(),
    referral: Object.assign({}, refInfo, { link: referralLink }),
    referralBoard: store.getReferralLeaderboardDay(20),
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
    cBalance: store.getCBalance(userId),
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
  res.json({ ok: true, deposit: result.deposit, flapBalance: store.getBalance(result.deposit.userId), cBalance: result.cBalance != null ? result.cBalance : result.balance });
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

// --- rolling backups / disaster recovery ---------------------------------
app.get('/internal/backups', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    res.json({ backups: await store.listBackups(), persist: store.persistInfo() });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/internal/backups/create', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const result = await store.createBackup((req.body && req.body.label) || 'manual');
  res.status(result.ok ? 200 : 500).json(result);
});

app.post('/internal/backups/restore', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const result = await store.restoreBackup(req.body && req.body.id);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Lightweight health probe: shows whether player data is safely persisted.
app.get('/internal/health', (req, res) => {
  const info = store.persistInfo();
  res.status(info.degraded ? 503 : 200).json({
    ok: !info.degraded && info.durable,
    persist: info,
  });
});

// REAL durability check: performs an actual write + read (and delete)
// round-trip against the live storage backend. Unlike /internal/health this
// does not just trust the env — it proves the backend is reachable AND
// writable right now, so you can confirm right before/after every deploy that
// player data will really survive it.
app.get('/internal/durability', async (req, res) => {
  try {
    const persist = store.persistInfo();
    const probe = await store.probeDurability();
    const good = !persist.degraded && probe.ok && (probe.durable !== false);
    res.status(good ? 200 : 503).json({ ok: good, persist, probe });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

const { runWeeklyRewardJob } = require('./rewards.js');
app.post('/internal/run-weekly-rewards', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const result = runWeeklyRewardJob(store);
  res.json(result);
});

app.post('/api/pvp/join', (req, res) => {
  const user = authenticate(req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });
  if (!store.allowRequest('pvpjoin:' + user.id, 20, 60 * 1000)) {
    return res.status(429).json({ error: 'too many PvP requests, slow down' });
  }
  const result = store.pvpJoin(String(user.id), displayName(user), Number(req.body.stake));
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(result);
});
app.post('/api/pvp/cancel', (req, res) => {
  const user = authenticate(req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });
  res.json(store.pvpCancel(String(user.id)));
});
app.post('/api/pvp/status', (req, res) => {
  const user = authenticate(req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });
  res.json(store.pvpStatus(String(user.id)));
});
app.post('/api/pvp/submit', (req, res) => {
  const user = authenticate(req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });
  const userId = String(user.id);
  if (!store.allowRequest('pvpsubmit:' + userId, 20, 60 * 1000)) {
    return res.status(429).json({ error: 'too many PvP submits, slow down' });
  }
  const { sessionId, flapLog, totalSteps } = req.body || {};
  // Don't consume a session unless it is actually this player's turn.
  const pre = store.pvpStatus(userId);
  if (pre && pre.match && pre.match.status === 'done') return res.json(pre);
  if (!pre || !pre.match || !pre.match.yourTurn) {
    return res.status(400).json({ error: 'not your turn' });
  }
  const peek = store.getSession(sessionId);
  if (peek && pre.match.turnStartedAt && peek.startedAt < pre.match.turnStartedAt) {
    return res.status(400).json({ error: 'stale session' });
  }
  // PvP never grants ad-revives: replay with an empty revive log so a forged
  // reviveLog can't inflate the stake-settling score.
  const verified = replaySession(sessionId, flapLog, totalSteps, [], {
    allowRevives: false,
    userId,
  });
  if (!verified.ok) return res.status(verified.status).json({ error: verified.error });
  const result = store.pvpSubmitScore(userId, verified.replay.score, {
    sessionStartedAt: verified.session.startedAt,
  });
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(result);
});
app.post('/api/pvp/decline', (req, res) => {
  const user = authenticate(req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });
  res.json(store.pvpDecline(String(user.id)));
});
app.post('/api/pvp/forfeit', (req, res) => {
  const user = authenticate(req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });
  res.json(store.pvpForfeit(String(user.id)));
});
app.post('/api/pvp/heartbeat', (req, res) => {
  const user = authenticate(req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });
  res.json(store.pvpHeartbeat(String(user.id)));
});
app.post('/api/pvp/ready', (req, res) => {
  const user = authenticate(req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });
  const result = store.pvpReady(String(user.id));
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(result);
});
app.post('/api/pvp/ack', (req, res) => {
  const user = authenticate(req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });
  res.json(store.pvpAck(String(user.id)));
});

const PORT = process.env.PORT || 3000;
const start = store.ready || Promise.resolve();
start.then(() => {
  app.listen(PORT, () => {
    const info = store.persistInfo();
    console.log(`GRM FLAP backend listening on :${PORT}`);
    console.log('Persist backend:', info.backend, info.redis ? '(Upstash Redis)' : store.dataFile);
    console.log(`Persist state: ${info.loadState} | players: ${info.players} | durable: ${info.durable}`);
    if (info.warning) console.warn('!!! DATA SAFETY WARNING:', info.warning);
    if (info.degraded) {
      console.error('!!! STORE DEGRADED — saving is blocked to protect existing player data.');
      console.error('    Reason:', info.loadError);
    }
  });
}).catch((err) => {
  console.error('Failed to load store:', err);
  process.exit(1);
});

module.exports = app;
