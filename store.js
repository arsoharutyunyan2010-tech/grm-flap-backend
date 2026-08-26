/**
 * Minimal in-memory store.
 *
 * ⚠️ PRODUCTION NOTE: this resets whenever the process restarts and does
 * not work across multiple server instances. For real deployment, swap
 * this module for Redis (sessions, short TTL) + Postgres/Mongo
 * (leaderboard history, balances, withdrawals) behind the same function
 * signatures below.
 */

const sessions = new Map();       // sessionId -> { userId, seed, startedAt, used }
const periodBoards = new Map();   // periodKey -> Map(userId -> { name, score, updatedAt })
const rewardHistory = [];         // archived weekly results
const rateBuckets = new Map();    // userId -> [timestamps]
const allTimeBest = new Map();    // userId -> { name, score }
const balances = new Map();       // userId -> number (FLAP coins; 100 FLAP = $1)
const withdrawals = [];           // { id, userId, name, address, amount, status, requestedAt, paidAt? }
let withdrawalSeq = 1;

const knownUsers = new Set();
const recentActivity = new Map();
let totalRuns = 0;

function currentDayKey(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD UTC
}

function currentWeekKey(d = new Date()) {
  // ISO week key, e.g. "2026-W34" — Mon–Sun week (UTC).
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((date - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function currentMonthKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function periodKey(period, d = new Date()) {
  if (period === 'day') return 'd:' + currentDayKey(d);
  if (period === 'month') return 'm:' + currentMonthKey(d);
  return 'w:' + currentWeekKey(d);
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

function upsertBoardScore(key, userId, name, score) {
  if (!periodBoards.has(key)) periodBoards.set(key, new Map());
  const board = periodBoards.get(key);
  const existing = board.get(userId);
  if (!existing || score > existing.score) {
    board.set(userId, { name, score, updatedAt: Date.now() });
  }
  return board.get(userId).score;
}

function submitPeriodScores(userId, name, score) {
  return {
    day: upsertBoardScore(periodKey('day'), userId, name, score),
    week: upsertBoardScore(periodKey('week'), userId, name, score),
    month: upsertBoardScore(periodKey('month'), userId, name, score),
  };
}

function submitWeeklyScore(userId, name, score, weekKey = currentWeekKey()) {
  return upsertBoardScore('w:' + weekKey, userId, name, score);
}

function getLeaderboard(periodOrWeekKey = 'week', limit = 20) {
  let key;
  let period = periodOrWeekKey;
  if (periodOrWeekKey === 'day' || periodOrWeekKey === 'week' || periodOrWeekKey === 'month') {
    key = periodKey(periodOrWeekKey);
  } else if (typeof periodOrWeekKey === 'string' && periodOrWeekKey.indexOf('w:') === 0) {
    key = periodOrWeekKey;
    period = 'week';
  } else if (typeof periodOrWeekKey === 'string' && /^\d{4}-W\d{2}$/.test(periodOrWeekKey)) {
    key = 'w:' + periodOrWeekKey;
    period = 'week';
  } else {
    key = periodKey('week');
    period = 'week';
  }
  const board = periodBoards.get(key) || new Map();
  const entries = Array.from(board.entries())
    .map(([userId, v]) => ({ userId, name: v.name, score: v.score }))
    .sort((a, b) => b.score - a.score);
  const ranked = entries.map((e, i) => Object.assign({ rank: i + 1 }, e));
  return { period, periodKey: key, ranked: ranked.slice(0, limit === Infinity ? ranked.length : limit), allRanked: ranked };
}

function getUserRank(userId, periodOrWeekKey = 'week') {
  const { allRanked } = getLeaderboard(periodOrWeekKey, Infinity);
  return allRanked.find(e => e.userId === userId) || null;
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
  periodBoards.delete('w:' + weekKey);
}

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

function getBalance(userId) {
  return balances.get(userId) || 0;
}
function creditBalance(userId, amount) {
  const bal = getBalance(userId) + amount;
  balances.set(userId, bal);
  return bal;
}

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
  return w;
}

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
function recordRun() {
  totalRuns++;
}
function getRunStats() {
  return { totalRuns };
}

module.exports = {
  currentDayKey, currentWeekKey, currentMonthKey, periodKey,
  createSession, getSession, consumeSession,
  submitPeriodScores, submitWeeklyScore, getLeaderboard, getUserRank,
  allowRequest,
  archiveWeek,
  rewardHistory,
  updateAllTimeBest, getAllTimeBest,
  getBalance, creditBalance,
  requestWithdrawal, listWithdrawals, markWithdrawalPaid,
  trackUser, getTotalUsers, getActivePlayers, recordRun, getRunStats,
};
