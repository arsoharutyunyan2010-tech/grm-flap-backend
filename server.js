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
 * server-computed number is ever written to the leaderboard.
 */
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const P = require('./physics.js');
const { verifyInitData } = require('./telegramAuth.js');
const store = require('./store.js');
require('./bot.js'); // Starts the Telegram bot (long polling) in this same process

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
app.post('/api/start-session', (req, res) => {
  const user = authenticate(req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });

  if (!store.allowRequest('start:' + user.id, 12, 60 * 1000)) {
    return res.status(429).json({ error: 'too many session starts, slow down' });
  }

  const sessionId = crypto.randomBytes(16).toString('hex');
  const seed = crypto.randomInt(1, 2 ** 31 - 1);
  store.createSession(sessionId, String(user.id), seed);
  sessionNames.set(sessionId, displayName(user));

  res.json({ sessionId, seed, physicsVersion: P.VERSION, maxRevives: P.MAX_REVIVES });
});

// ---------------------------------------------------------------
// POST /api/submit-score
// Replays the run server-side from the session's seed + the submitted
// flap log + revive log, and only ever stores the SERVER's number.
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
  // Each revive gets a small extra time allowance (an ad takes real time).
  const elapsedRealMs = Date.now() - session.startedAt;
  const revivesClaimed = Math.min(revives.length, P.MAX_REVIVES);
  const AD_ALLOWANCE_MS = 20000; // generous allowance per ad watched
  const claimedMs = totalSteps * (P.STEP * 1000);
  const TOLERANCE = 1.15;
  if (claimedMs > (elapsedRealMs + revivesClaimed * AD_ALLOWANCE_MS) * TOLERANCE + 2000) {
    store.consumeSession(sessionId);
    return res.status(400).json({ error: 'submission rejected: implausible timing' });
  }

  const allowedSteps = Math.min(
    totalSteps,
    Math.ceil(((elapsedRealMs + revivesClaimed * AD_ALLOWANCE_MS) / 1000) / P.STEP) + 5
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

  res.json({
    score: verifiedScore,
    clientScoreMismatch: verifiedScore !== clientScore,
    best,
    allTimeBest,
    rank: rankInfo ? rankInfo.rank : null,
    weekKey,
    revivesUsed: replay.revivesUsed,
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
// Player's own stats: all-time best score + GRM balance + this
// week's rank. Used by the Profile and Wallet tabs.
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
// POST /api/withdraw
// Player requests a GRM -> TON withdrawal. Balance is deducted
// immediately; the request sits as "pending" until the admin manually
// sends the TON (see GET /internal/withdrawals) and marks it paid.
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
// GET /internal/withdrawals?status=pending  (admin only)
// POST /internal/withdrawals/:id/paid       (admin only, mark paid)
// ---------------------------------------------------------------
app.get('/internal/withdrawals', (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'forbidden' });
  }
  res.json({ withdrawals: store.listWithdrawals(req.query.status) });
});

app.post('/internal/withdrawals/:id/paid', (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const w = store.markWithdrawalPaid(Number(req.params.id));
  if (!w) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true, withdrawal: w });
});

// ---------------------------------------------------------------
// GET /adsgram-reward?userid=...
// Server-side postback Adsgram calls when a rewarded ad has been
// watched in full. The game's own logic (start-session / revive) is
// already what actually gates the game, so this endpoint just has to
// exist and respond 200 — it's logged for visibility/debugging.
// ---------------------------------------------------------------
app.get('/adsgram-reward', (req, res) => {
  const userId = req.query.userid || 'unknown';
  console.log(`[adsgram] reward postback received for user ${userId}`);
  res.status(200).send('OK');
});

// ---------------------------------------------------------------
// Weekly reward distribution (see rewards.js).
// ---------------------------------------------------------------
const { runWeeklyRewardJob } = require('./rewards.js');
app.post('/internal/run-weekly-rewards', (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const result = runWeeklyRewardJob(store);
  res.json(result);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GRM FLAP backend listening on :${PORT}`));

module.exports = app;
