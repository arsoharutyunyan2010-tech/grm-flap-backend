/**
 * GRM FLAP backend
 * -----------------
 * Flow: Telegram Bot -> Mini App (index.html) -> this server -> leaderboard -> weekly GRM rewards -> wallet withdrawal.
 *
 * The core anti-cheat idea: the client NEVER gets to tell the server "my score is X".
 * It only gets to say "here is the random seed you gave me, the exact list of
 * steps at which I tapped, and the exact list of steps at which I used a
 * revive." The server re-runs the same deterministic simulation (physics.js,
 * shared with the client) and computes the score itself. Only that
 * server-computed number is ever written to the leaderboard, and only that
 * number is ever used to credit GRM.
 */
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const P = require('./physics.js');
const { verifyInitData } = require('./telegramAuth.js');
const store = require('./store.js');
const { checkSubscriptions } = require('./subscription.js');

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(__dirname));

// Maps sessionId -> verified display name, resolved once at session
// start from the (verified) Telegram initData. Never trust a name the
// client claims later at submit time.
const sessionNames = new Map();

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ALLOW_INSECURE_DEV = process.env.ALLOW_INSECURE_DEV === 'true'; // local testing only, without a real Telegram launch
const INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60;

// Reward for each pipe successfully passed (i.e. each point of score).
// Applied server-side against the VERIFIED score only — never trusts a
// client-claimed score.
const GRM_PER_PIPE = 0.05;

// ---------------------------------------------------------------
// Auth helper: verify Telegram initData, or fall back to a fake
// dev user ONLY when explicitly enabled via env var.
// ---------------------------------------------------------------
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

// ---------------------------------------------------------------
// POST /api/start-session
// ---------------------------------------------------------------
app.post('/api/start-session', async (req, res) => {
  const user = authenticate(req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });

  if (!store.allowRequest('start:' + user.id, 12, 60 * 1000)) {
    return res.status(429).json({ error: 'too many session starts, slow down' });
  }

  if (!ALLOW_INSECURE_DEV) {
    try {
      const sub = await checkSubscriptions(BOT_TOKEN, user.id);
      if (!sub.subscribed) {
        return res.status(403).json({
          error: 'subscription_required',
          channelJoined: sub.channelJoined,
          chatJoined: sub.chatJoined,
          channels: sub.channels,
        });
      }
    } catch (err) {
      console.error('start-session subscription check failed:', err);
      return res.status(503).json({ error: 'subscription check failed' });
    }
  }

  store.trackUser(String(user.id));

  const sessionId = crypto.randomBytes(16).toString('hex');
  const seed = crypto.randomInt(1, 2 ** 31 - 1);
  store.createSession(sessionId, String(user.id), seed);
  sessionNames.set(sessionId, displayName(user));

  res.json({ sessionId, seed, physicsVersion: P.VERSION, maxRevives: P.MAX_REVIVES });
});

// ---------------------------------------------------------------
// POST /api/submit-score
// Replays the run server-side from the session's seed + the submitted
// flap log + revive log, and only ever stores/pays the SERVER's number.
// ---------------------------------------------------------------
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

  // Anti-cheat: you cannot claim more simulated game-time than real
  // wall-clock time has actually passed since the session started.
  // Each revive gets a small extra time allowance.
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
  const weekKey = store.currentWeekKey();
  const name = sessionNames.get(sessionId) || 'Player';
  sessionNames.delete(sessionId);
  const best = store.submitWeeklyScore(session.userId, name, verifiedScore, weekKey);
  const allTimeBest = store.updateAllTimeBest(session.userId, name, verifiedScore);
  const rankInfo = store.getUserRank(session.userId, weekKey);

  const grmEarned = Math.round(verifiedScore * GRM_PER_PIPE * 100) / 100;
  const balance = grmEarned > 0 ? store.creditBalance(session.userId, grmEarned) : store.getBalance(session.userId);
  store.recordRun(grmEarned);

  res.json({
    score: verifiedScore,
    clientScoreMismatch: verifiedScore !== clientScore,
    best,
    allTimeBest,
    rank: rankInfo ? rankInfo.rank : null,
    weekKey,
    revivesUsed: replay.revivesUsed,
    grmEarned,
    balance,
  });
});

// ---------------------------------------------------------------
// GET /api/leaderboard?uid=123
// ---------------------------------------------------------------
app.get('/api/leaderboard', (req, res) => {
  const weekKey = store.currentWeekKey();
  const { ranked } = store.getLeaderboard(weekKey, 20);
  const top = ranked.slice(0, 20).map(e => ({ rank: e.rank, name: e.name, score: e.score }));

  let me = null;
  if (req.query.uid) {
    const mine = store.getUserRank(String(req.query.uid), weekKey);
    if (mine) me = { rank: mine.rank, score: mine.score };
  }

  res.json({ period: weekKey, entries: top, me });
});

// ---------------------------------------------------------------
// POST /api/profile
// ---------------------------------------------------------------
app.post('/api/profile', (req, res) => {
  const user = authenticate(req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });

  const userId = String(user.id);
  const weekKey = store.currentWeekKey();
  const rankInfo = store.getUserRank(userId, weekKey);

  res.json({
    name: displayName(user),
    best: store.getAllTimeBest(userId),
    balance: store.getBalance(userId),
    rank: rankInfo ? rankInfo.rank : null,
    weekKey,
  });
});

// ---------------------------------------------------------------
// POST /api/check-subscription
// Verifies via Telegram Bot API that the user joined both required
// chats. The Mini App never gets to decide this itself.
// ---------------------------------------------------------------
app.post('/api/check-subscription', async (req, res) => {
  const user = authenticate(req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });

  const userId = String(user.id);
  if (!store.allowRequest('subcheck:' + userId, 20, 60 * 1000)) {
    return res.status(429).json({ error: 'too many checks, slow down' });
  }

  if (!BOT_TOKEN) {
    return res.status(500).json({ error: 'Bot token not configured on server' });
  }

  try {
    const result = await checkSubscriptions(BOT_TOKEN, user.id, { force: !!req.body.force });
    res.json({
      subscribed: result.subscribed,
      channelJoined: result.channelJoined,
      chatJoined: result.chatJoined,
      channels: result.channels,
    });
  } catch (error) {
    console.error('Subscription check error:', error);
    res.status(500).json({ error: 'Failed to check subscription' });
  }
});

// ---------------------------------------------------------------
// POST /api/withdraw
// ---------------------------------------------------------------
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

  res.json({ ok: true, requestId: result.request.id, balance: result.balance });
});

// ---------------------------------------------------------------
// Admin-only endpoints (require x-admin-key header)
// ---------------------------------------------------------------
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

app.get('/internal/stats', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const runStats = store.getRunStats();
  res.json({
    totalUsers: store.getTotalUsers(),
    activePlayers: store.getActivePlayers(),
    totalRuns: runStats.totalRuns,
    avgGrmPerRun: runStats.avgGrmPerRun,
  });
});

// ---------------------------------------------------------------
// Weekly reward distribution (see rewards.js).
// ---------------------------------------------------------------
const { runWeeklyRewardJob } = require('./rewards.js');
app.post('/internal/run-weekly-rewards', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const result = runWeeklyRewardJob(store);
  res.json(result);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GRM FLAP backend listening on :${PORT}`));

module.exports = app;
