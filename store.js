/**
 * Minimal in-memory store.
 *
 * ⚠️ PRODUCTION NOTE: this resets whenever the process restarts and does
 * not work across multiple server instances. For real deployment, swap
 * this module for Redis (sessions, short TTL) + Postgres/Mongo
 * (leaderboard history) behind the same function signatures below.
 */

const sessions = new Map();       // sessionId -> { userId, seed, startedAt, used }
const weeklyScores = new Map();   // weekKey -> Map(userId -> { name, score, updatedAt })
const rewardHistory = [];         // archived weekly results
const rateBuckets = new Map();    // userId -> [timestamps]

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
// Periodically forget old sessions so memory doesn't grow unbounded.
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000; // 2h
  for (const [id, s] of sessions) if (s.startedAt < cutoff) sessions.delete(id);
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

// Simple sliding-window rate limiter: `limit` calls per `windowMs`.
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
}

module.exports = {
  currentWeekKey,
  createSession, getSession, consumeSession,
  submitWeeklyScore, getLeaderboard, getUserRank,
  allowRequest,
  archiveWeek,
  rewardHistory,
};
