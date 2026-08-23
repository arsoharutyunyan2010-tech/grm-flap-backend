/**
 * In-memory store with Upstash Redis persistence to survive redeploys.
 *
 * Requires two env vars (from your Upstash database's REST API panel):
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 *
 * Everything is kept as a single JSON blob under one Redis key, loaded
 * once at boot and saved periodically + after any write that matters
 * (withdrawals, weekly archive). Sessions/rate-limits are NOT persisted
 * (short-lived, fine to reset on redeploy).
 */
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const REDIS_KEY = 'grmflap:state';

const sessions = new Map();
const weeklyScores = new Map();
const rewardHistory = [];
const rateBuckets = new Map();
const allTimeBest = new Map();
const balances = new Map();
const withdrawals = [];
let withdrawalSeq = 1;

const knownUsers = new Set();
const recentActivity = new Map();
let totalRuns = 0;
let totalGrmPaid = 0;

// ---------------------------------------------------------------
// Upstash REST helpers
// ---------------------------------------------------------------
async function redisGet(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
  if (!r.ok) throw new Error('redis GET failed: ' + r.status);
  const data = await r.json();
  return data.result || null;
}
async function redisSet(key, value) {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  const r = await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'text/plain' },
    body: value
  });
  if (!r.ok) throw new Error('redis SET failed: ' + r.status);
}

// ---------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------
let readyResolve;
const ready = new Promise((res) => { readyResolve = res; });

async function loadFromRedis() {
  try {
    const raw = await redisGet(REDIS_KEY);
    if (!raw) { console.log('[store] no persisted data yet (fresh start)'); return; }
    const data = JSON.parse(raw);
    (data.weeklyScores || []).forEach(([wk, entries]) => weeklyScores.set(wk, new Map(entries)));
    (data.allTimeBest || []).forEach(([uid, v]) => allTimeBest.set(uid, v));
    (data.balances || []).forEach(([uid, v]) => balances.set(uid, v));
    (data.withdrawals || []).forEach(w => withdrawals.push(w));
    withdrawalSeq = data.withdrawalSeq || 1;
    (data.rewardHistory || []).forEach(r => rewardHistory.push(r));
    (data.knownUsers || []).forEach(u => knownUsers.add(u));
    totalRuns = data.totalRuns || 0;
    totalGrmPaid = data.totalGrmPaid || 0;
    console.log('[store] loaded persisted data from Upstash');
  } catch (e) {
    console.error('[store] failed to load from Upstash:', e.message);
  }
}

let saveInFlight = false;
let saveQueued = false;
async function saveToRedis() {
  if (saveInFlight) { saveQueued = true; return; }
  saveInFlight = true;
  try {
    const out = {
      weeklyScores: Array.from(weeklyScores.entries()).map(([wk, m]) => [wk, Array.from(m.entries())]),
      allTimeBest: Array.from(allTimeBest.entries()),
      balances: Array.from(balances.entries()),
      withdrawals,
      withdrawalSeq,
      rewardHistory,
      knownUsers: Array.from(knownUsers),
      totalRuns,
      totalGrmPaid,
    };
    await redisSet(REDIS_KEY, JSON.stringify(out));
  } catch (e) {
    console.error('[store] failed to save to Upstash:', e.message);
  } finally {
    saveInFlight = false;
    if (saveQueued) { saveQueued = false; saveToRedis(); }
  }
}

loadFromRedis().finally(() => readyResolve());
setInterval(saveToRedis, 15 * 1000).unref();
process.on('SIGTERM', () => { saveToRedis().finally(() => process.exit(0)); });
process.on('SIGINT', () => { saveToRedis().finally(() => process.exit(0)); });

function currentWeekKey(d = new Date()) {
  // ISO week key, e.g. "2026-W34" — ties the leaderboard to a Mon–Sun week (UTC).
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((date - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function createSession(sessionId, userId, seed) {
  sessions.set(sessionId, { userId, seed, startedAt: Date.now(), used: false });
}
function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}
function consumeSession(sessionId) {
  const s = sessions.get(sessionId);
  if (s) s.used = true;
}
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, s] of sessions) if (s.startedAt < cutoff) sessions.delete(id);
  const actCutoff = Date.now() - 10 * 60 * 1000;
  for (const [uid, ts] of recentActivity) if (ts < actCutoff) recentActivity.delete(uid);
}, 10 * 60 * 1000).unref();

function submitWeeklyScore(userId, name, score, weekKey = currentWeekKey()) {
  if (!weeklyScores.has(weekKey)) weeklyScores.set(weekKey, new Map());
  const board = weeklyScores.get(weekKey);
  const existing = board.get(userId);
  if (!existing || score > existing.score) {
    board.set(userId, { name, score, updatedAt: Date.now() });
  }
  return board.get(userId).score;
}

function getLeaderboard(weekKey = currentWeekKey(), limit = 20) {
  const board = weeklyScores.get(weekKey) || new Map();
  const entries = Array.from(board.entries())
    .map(([userId, v]) => ({ userId, name: v.name, score: v.score }))
    .sort((a, b) => b.score - a.score);
  const ranked = entries.map((e, i) => Object.assign({ rank: i + 1 }, e));
  return { weekKey, ranked };
}

function getUserRank(userId, weekKey = currentWeekKey()) {
  const { ranked } = getLeaderboard(weekKey, Infinity);
  return ranked.find(e => e.userId === userId) || null;
}

function allowRequest(userId, limit, windowMs) {
  const now = Date.now();
  const bucket = (rateBuckets.get(userId) || []).filter(t => now - t < windowMs);
  if (bucket.length >= limit) { rateBuckets.set(userId, bucket); return false; }
  bucket.push(now);
  rateBuckets.set(userId, bucket);
  return true;
}

function archiveWeek(weekKey, payouts) {
  rewardHistory.push({ weekKey, payouts, archivedAt: Date.now() });
  weeklyScores.delete(weekKey);
  saveToRedis();
}

// ---------------------------------------------------------------
// All-time best score (independent of the weekly leaderboard, which
// resets). Shown on the player's profile.
// ---------------------------------------------------------------
function updateAllTimeBest(userId, name, score) {
  const existing = allTimeBest.get(userId);
  if (!existing || score > existing.score) {
    allTimeBest.set(userId, { name, score });
  }
  return allTimeBest.get(userId).score;
}
function getAllTimeBest(userId) {
  const e = allTimeBest.get(userId);
  return e ? e.score : 0;
}

// ---------------------------------------------------------------
// GRM balance — credited by the weekly reward job (see rewards.js) and
// by per-pipe run earnings, debited when a withdrawal request is made.
// ---------------------------------------------------------------
function getBalance(userId) {
  return balances.get(userId) || 0;
}
function creditBalance(userId, amount) {
  const bal = getBalance(userId) + amount;
  balances.set(userId, bal);
  return bal;
}

// ---------------------------------------------------------------
// Withdrawal requests — the player enters a TON address + amount,
// the amount is deducted from their balance immediately (so it can't
// be double-spent), and the request sits as "pending" until the admin
// manually sends the TON and marks it paid.
// ---------------------------------------------------------------
function requestWithdrawal(userId, name, address, amount) {
  const bal = getBalance(userId);
  if (!(amount > 0)) return { ok: false, error: 'invalid amount' };
  if (amount > bal) return { ok: false, error: 'insufficient balance' };
  balances.set(userId, bal - amount);
  const request = {
    id: withdrawalSeq++,
    userId, name, address, amount,
    status: 'pending',
    requestedAt: Date.now(),
  };
  withdrawals.push(request);
  saveToRedis();
  return { ok: true, request, balance: bal - amount };
}
function listWithdrawals(status) {
  return status ? withdrawals.filter(w => w.status === status) : withdrawals.slice();
}
function markWithdrawalPaid(id) {
  const w = withdrawals.find(w => w.id === id);
  if (!w) return null;
  w.status = 'paid';
  w.paidAt = Date.now();
  saveToRedis();
  return w;
}

// ---------------------------------------------------------------
// Bot-wide stats, for the admin panel.
// ---------------------------------------------------------------
function trackUser(userId) {
  knownUsers.add(userId);
  recentActivity.set(userId, Date.now());
}
function getTotalUsers() {
  return knownUsers.size;
}
function getActivePlayers(windowMs = 5 * 60 * 1000) {
  const now = Date.now();
  let count = 0;
  for (const ts of recentActivity.values()) if (now - ts < windowMs) count++;
  return count;
}
function recordRun(grmEarned) {
  totalRuns++;
  totalGrmPaid += grmEarned || 0;
}
function getRunStats() {
  return {
    totalRuns,
    avgGrmPerRun: totalRuns ? Math.round((totalGrmPaid / totalRuns) * 100) / 100 : 0,
  };
}

module.exports = {
  ready,
  currentWeekKey,
  createSession, getSession, consumeSession,
  submitWeeklyScore, getLeaderboard, getUserRank,
  allowRequest,
  archiveWeek,
  rewardHistory,
  updateAllTimeBest, getAllTimeBest,
  getBalance, creditBalance,
  requestWithdrawal, listWithdrawals, markWithdrawalPaid,
  trackUser, getTotalUsers, getActivePlayers, recordRun, getRunStats,
};
