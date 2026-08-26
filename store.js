/**
 * Player data store with JSON file persistence.
 *
 * Scores, ranks, FLAP balances and withdrawals survive process restarts
 * as long as DATA_FILE points at a durable disk (Railway Volume).
 *
 * On Railway: create a Volume mounted at /data and set
 *   DATA_FILE=/data/store.json
 * Without a volume, every GitHub deploy starts a fresh container and
 * in-memory + local-disk data is lost.
 */

const fs = require('fs');
const path = require('path');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'store.json');

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
let saveTimer = null;

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

function snapshot() {
  const boards = {};
  for (const [key, board] of periodBoards) {
    const rows = {};
    for (const [uid, row] of board) rows[String(uid)] = row;
    boards[key] = rows;
  }
  const best = {};
  for (const [uid, row] of allTimeBest) best[String(uid)] = row;
  const bals = {};
  for (const [uid, n] of balances) bals[String(uid)] = n;
  return {
    version: 1,
    savedAt: Date.now(),
    periodBoards: boards,
    allTimeBest: best,
    balances: bals,
    withdrawals,
    withdrawalSeq,
    knownUsers: Array.from(knownUsers).map(String),
    totalRuns,
    rewardHistory,
  };
}

function hydrate(data) {
  if (!data || typeof data !== 'object') return;
  periodBoards.clear();
  const boards = data.periodBoards || {};
  for (const key of Object.keys(boards)) {
    const m = new Map();
    const rows = boards[key] || {};
    for (const uid of Object.keys(rows)) {
      const row = rows[uid];
      if (row && Number.isFinite(row.score)) {
        m.set(String(uid), {
          name: row.name || 'Player',
          score: row.score,
          updatedAt: row.updatedAt || 0,
        });
      }
    }
    periodBoards.set(key, m);
  }

  allTimeBest.clear();
  const best = data.allTimeBest || {};
  for (const uid of Object.keys(best)) {
    const row = best[uid];
    if (row && Number.isFinite(row.score)) {
      allTimeBest.set(String(uid), { name: row.name || 'Player', score: row.score });
    }
  }

  balances.clear();
  const bals = data.balances || {};
  for (const uid of Object.keys(bals)) {
    const n = Number(bals[uid]);
    if (Number.isFinite(n)) balances.set(String(uid), n);
  }

  withdrawals.length = 0;
  if (Array.isArray(data.withdrawals)) {
    for (const w of data.withdrawals) {
      if (w && w.id != null) withdrawals.push(w);
    }
  }
  const maxId = withdrawals.reduce((m, w) => Math.max(m, Number(w.id) || 0), 0);
  withdrawalSeq = Math.max(Number(data.withdrawalSeq) || 1, maxId + 1);

  knownUsers.clear();
  if (Array.isArray(data.knownUsers)) {
    for (const uid of data.knownUsers) knownUsers.add(String(uid));
  }

  totalRuns = Number(data.totalRuns) || 0;

  rewardHistory.length = 0;
  if (Array.isArray(data.rewardHistory)) {
    for (const row of data.rewardHistory) rewardHistory.push(row);
  }
}

function saveNow() {
  try {
    const dir = path.dirname(DATA_FILE);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snapshot()), 'utf8');
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.error('store save failed:', err.message || err);
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 80);
  if (saveTimer.unref) saveTimer.unref();
}

function loadFromDisk() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      console.log('store: no data file yet at', DATA_FILE);
      return;
    }
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    hydrate(JSON.parse(raw));
    console.log(
      'store: loaded',
      allTimeBest.size, 'players,',
      periodBoards.size, 'boards from',
      DATA_FILE
    );
  } catch (err) {
    console.error('store load failed:', err.message || err);
  }
}

loadFromDisk();

function flushAndExit(code) {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveNow();
  process.exit(code);
}
process.on('SIGTERM', () => flushAndExit(0));
process.on('SIGINT', () => flushAndExit(0));

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
  userId = String(userId);
  if (!periodBoards.has(key)) periodBoards.set(key, new Map());
  const board = periodBoards.get(key);
  const existing = board.get(userId);
  if (!existing || score > existing.score) {
    board.set(userId, { name, score, updatedAt: Date.now() });
    scheduleSave();
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
  return allRanked.find(e => e.userId === String(userId)) || null;
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
  scheduleSave();
}

function updateAllTimeBest(userId, name, score) {
  userId = String(userId);
  const existing = allTimeBest.get(userId);
  if (!existing || score > existing.score) {
    allTimeBest.set(userId, { name, score });
    scheduleSave();
  }
  return allTimeBest.get(userId).score;
}
function getAllTimeBest(userId) {
  const e = allTimeBest.get(String(userId));
  return e ? e.score : 0;
}

function getBalance(userId) {
  return balances.get(String(userId)) || 0;
}
function creditBalance(userId, amount) {
  const bal = getBalance(userId) + amount;
  balances.set(String(userId), bal);
  scheduleSave();
  return bal;
}

function requestWithdrawal(userId, name, address, amount) {
  userId = String(userId);
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
  scheduleSave();
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
  scheduleSave();
  return w;
}

function trackUser(userId) {
  userId = String(userId);
  const wasNew = !knownUsers.has(userId);
  knownUsers.add(userId);
  recentActivity.set(userId, Date.now());
  if (wasNew) scheduleSave();
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
  scheduleSave();
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
  dataFile: DATA_FILE,
  flush: saveNow,
};
