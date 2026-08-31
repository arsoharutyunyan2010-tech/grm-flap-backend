/**
 * Player data store.
 *
 * Prefers Upstash Redis when UPSTASH_REDIS_REST_URL + TOKEN are set
 * (survives every GitHub / Railway deploy). Falls back to DATA_FILE.
 */

const fs = require('fs');
const path = require('path');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'store.json');
const FALLBACK_FILE = path.join(__dirname, 'data', 'store.json');
const UPSTASH_URL = String(
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_KV_REST_URL ||
  ''
).replace(/\/$/, '');
const UPSTASH_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.KV_REST_API_TOKEN ||
  process.env.UPSTASH_REDIS_KV_REST_TOKEN ||
  '';
const REDIS_KEY = process.env.STORE_REDIS_KEY || 'flapy:store';
const useRedis = !!(UPSTASH_URL && UPSTASH_TOKEN);

const sessions = new Map();       // sessionId -> { userId, seed, startedAt, used }
const periodBoards = new Map();   // periodKey -> Map(userId -> { name, score, updatedAt })
const rewardHistory = [];         // archived weekly results
const rateBuckets = new Map();    // userId -> [timestamps]
const allTimeBest = new Map();    // userId -> { name, score }
const balances = new Map();       // userId -> number (FLAP coins; withdraw only; 100 FLAP = $1)
const cBalances = new Map();      // userId -> number (C coins; top-up; 100 C = $1)
const withdrawals = [];           // { id, userId, name, address, amount, status, requestedAt, paidAt? }
let withdrawalSeq = 1;
const deposits = [];              // { id, userId, name, amount, txHash, status, requestedAt }
let depositSeq = 1;

const knownUsers = new Set();
const recentActivity = new Map();
let totalRuns = 0;
let saveTimer = null;
const pvpQueue = new Map();
const pvpMatches = new Map();
const pvpByUser = new Map();
let pvpHouseC = 0;

const referralByUser = new Map(); // userId -> { code, referredBy, name, invited: [{id,name,at}], earned }
const referralCodeIndex = new Map(); // code -> userId
const dailyInvites = new Map(); // YYYY-MM-DD -> Map(userId -> { name, count })

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
  const cBals = {};
  for (const [uid, n] of cBalances) cBals[String(uid)] = n;
  return {
    version: 1,
    savedAt: Date.now(),
    periodBoards: boards,
    allTimeBest: best,
    balances: bals,
    cBalances: cBals,
    withdrawals,
    withdrawalSeq,
    deposits,
    depositSeq,
    knownUsers: Array.from(knownUsers).map(String),
    totalRuns,
    rewardHistory,
    pvpMatches: Array.from(pvpMatches.values()),
    referrals: Object.fromEntries(Array.from(referralByUser.entries()).map(([uid, row]) => [uid, row])),
    dailyInvites: (function () {
      const out = {};
      for (const [day, m] of dailyInvites) {
        const rows = {};
        for (const [uid, row] of m) rows[uid] = row;
        out[day] = rows;
      }
      return out;
    })(),
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

  cBalances.clear();
  const cBals = data.cBalances || {};
  for (const uid of Object.keys(cBals)) {
    const n = Number(cBals[uid]);
    if (Number.isFinite(n)) cBalances.set(String(uid), n);
  }

  withdrawals.length = 0;
  if (Array.isArray(data.withdrawals)) {
    for (const w of data.withdrawals) {
      if (w && w.id != null) withdrawals.push(w);
    }
  }
  const maxId = withdrawals.reduce((m, w) => Math.max(m, Number(w.id) || 0), 0);
  withdrawalSeq = Math.max(Number(data.withdrawalSeq) || 1, maxId + 1);

  deposits.length = 0;
  if (Array.isArray(data.deposits)) {
    for (const d of data.deposits) {
      if (d && d.id != null) deposits.push(d);
    }
  }
  const maxDepId = deposits.reduce((m, d) => Math.max(m, Number(d.id) || 0), 0);
  depositSeq = Math.max(Number(data.depositSeq) || 1, maxDepId + 1);

  knownUsers.clear();
  if (Array.isArray(data.knownUsers)) {
    for (const uid of data.knownUsers) knownUsers.add(String(uid));
  }
  for (const uid of allTimeBest.keys()) knownUsers.add(String(uid));

  totalRuns = Number(data.totalRuns) || 0;

  rewardHistory.length = 0;
  if (Array.isArray(data.rewardHistory)) {
    for (const row of data.rewardHistory) rewardHistory.push(row);
  }

  pvpMatches.clear();
  pvpByUser.clear();
  if (Array.isArray(data.pvpMatches)) {
    for (const m of data.pvpMatches) {
      if (m && m.id && m.status !== 'done') {
        pvpMatches.set(m.id, m);
        if (m.p1 && m.p1.userId) pvpByUser.set(String(m.p1.userId), m.id);
        if (m.p2 && m.p2.userId) pvpByUser.set(String(m.p2.userId), m.id);
      }
    }
  }
}

function writeJsonFile(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, filePath);
}

function saveFile() {
  const json = JSON.stringify(snapshot());
  try {
    writeJsonFile(DATA_FILE, json);
  } catch (err) {
    console.error('store file save failed:', err.message || err);
  }
  if (path.resolve(FALLBACK_FILE) !== path.resolve(DATA_FILE)) {
    try { writeJsonFile(FALLBACK_FILE, json); } catch (e) {}
  }
}

async function redisCmd(cmd) {
  const res = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + UPSTASH_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(cmd),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('upstash HTTP ' + res.status));
  return data.result;
}

function snapshotHasPlayers(snap) {
  return !!(
    (snap.knownUsers && snap.knownUsers.length) ||
    (snap.allTimeBest && Object.keys(snap.allTimeBest).length) ||
    snap.totalRuns
  );
}

async function saveRedis() {
  const snap = snapshot();
  if (!snapshotHasPlayers(snap)) {
    try {
      const existing = await redisCmd(['GET', REDIS_KEY]);
      if (existing) {
        console.warn('store: skip empty Redis overwrite (keeping previous scores)');
        return;
      }
    } catch (err) {
      console.warn('store: skip empty Redis save', err.message || err);
      return;
    }
  }
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      await redisCmd(['SET', REDIS_KEY, JSON.stringify(snap)]);
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  throw lastErr;
}

function saveNow() {
  saveFile();
  if (useRedis) {
    saveRedis().catch((err) => console.error('store redis save failed:', err.message || err));
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
  const files = [DATA_FILE];
  if (path.resolve(FALLBACK_FILE) !== path.resolve(DATA_FILE)) files.push(FALLBACK_FILE);
  for (const filePath of files) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const raw = fs.readFileSync(filePath, 'utf8');
      hydrate(JSON.parse(raw));
      console.log(
        'store: loaded',
        allTimeBest.size, 'players,',
        periodBoards.size, 'boards from',
        filePath
      );
      return true;
    } catch (err) {
      console.error('store file load failed:', filePath, err.message || err);
    }
  }
  console.log('store: no data file yet at', DATA_FILE);
  return false;
}

async function loadAll() {
  if (useRedis) {
    try {
      const raw = await redisCmd(['GET', REDIS_KEY]);
      if (raw) {
        hydrate(typeof raw === 'string' ? JSON.parse(raw) : raw);
        console.log(
          'store: loaded',
          allTimeBest.size, 'players,',
          periodBoards.size, 'boards from Upstash Redis'
        );
        return;
      }
      console.log('store: Redis key empty, trying local file');
    } catch (err) {
      console.error('store redis load failed:', err.message || err);
    }
  }
  const fromFile = loadFromDisk();
  if (useRedis && fromFile) {
    try {
      await saveRedis();
      console.log('store: copied file snapshot into Redis');
    } catch (err) {
      console.error('store redis seed failed:', err.message || err);
    }
  }
}

const ready = loadAll();

function flushAndExit(code) {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveFile();
  const done = useRedis ? saveRedis() : Promise.resolve();
  done.catch((err) => console.error('store flush failed:', err.message || err))
    .then(() => process.exit(code));
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
function getCBalance(userId) {
  return cBalances.get(String(userId)) || 0;
}
function creditCBalance(userId, amount) {
  const bal = getCBalance(userId) + amount;
  cBalances.set(String(userId), bal);
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

function requestDeposit(userId, name, amount, txHash) {
  userId = String(userId);
  if (!(amount > 0)) return { ok: false, error: 'invalid amount' };
  const request = {
    id: depositSeq++,
    userId,
    name,
    amount,
    txHash: String(txHash || '').trim(),
    status: 'pending',
    requestedAt: Date.now(),
  };
  deposits.push(request);
  scheduleSave();
  return { ok: true, request };
}
function listDeposits(status) {
  return status ? deposits.filter(d => d.status === status) : deposits.slice();
}
function approveDeposit(id) {
  const d = deposits.find(x => x.id === id);
  if (!d || d.status !== 'pending') return null;
  d.status = 'approved';
  d.approvedAt = Date.now();
  const cBalance = creditCBalance(d.userId, d.amount);
  scheduleSave();
  return { deposit: d, balance: cBalance, cBalance };
}
function rejectDeposit(id) {
  const d = deposits.find(x => x.id === id);
  if (!d || d.status !== 'pending') return null;
  d.status = 'rejected';
  d.rejectedAt = Date.now();
  scheduleSave();
  return d;
}

function trackUser(userId) {
  userId = String(userId);
  const wasNew = !knownUsers.has(userId);
  knownUsers.add(userId);
  recentActivity.set(userId, Date.now());
  if (wasNew) scheduleSave();
}
function getTotalUsers() {
  return Math.max(knownUsers.size, allTimeBest.size);
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

const PVP_STAKES = [10, 20, 30, 50, 75, 100, 250, 500, 1000];
const PVP_TURN_MS = 3 * 60 * 1000;
const PVP_CONFIRM_MS = 5000;
const PVP_AFK_MS = 20 * 1000;

function newPvpId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function publicPvp(match, userId) {
  userId = String(userId);
  const youAre = match.p1.userId === userId ? 'p1' : (match.p2.userId === userId ? 'p2' : null);
  return {
    id: match.id,
    stake: match.stake,
    bank: match.bank,
    prize: Math.floor(match.bank * 0.9),
    status: match.status,
    turn: match.turn,
    paid: !!match.paid,
    confirmUntil: match.confirmUntil || 0,
    forfeit: !!match.forfeit,
    youAre,
    yourTurn: !!(youAre && match.turn === youAre && (match.status === 'p1_playing' || match.status === 'p2_playing')),
    youReady: !!(youAre && match[youAre] && match[youAre].ready),
    p1: { name: match.p1.name, score: match.p1.score, ready: !!match.p1.ready },
    p2: { name: match.p2.name, score: match.p2.score, ready: !!match.p2.ready },
    winner: match.winner || null,
    winnerPrize: match.winnerPrize || 0,
    cBalance: getCBalance(userId),
  };
}

function pvpClearUser(userId) {
  pvpByUser.delete(String(userId));
}

function pvpRequeue(userId, name, stake) {
  if (getCBalance(userId) < stake) return;
  let q = pvpQueue.get(stake) || [];
  if (q.some((x) => x.userId === String(userId))) return;
  q.push({ userId: String(userId), name: name || 'Player', joinedAt: Date.now() });
  pvpQueue.set(stake, q);
}

function pvpDropMatch(match) {
  pvpMatches.delete(match.id);
  if (match.p1) pvpClearUser(match.p1.userId);
  if (match.p2) pvpClearUser(match.p2.userId);
}

function pvpAbortConfirm(match, declinedUserId) {
  if (!match || match.status !== 'confirming' || match.paid) return;
  const d = String(declinedUserId);
  const other = match.p1.userId === d ? match.p2 : match.p1;
  pvpDropMatch(match);
  if (other && other.userId !== d) pvpRequeue(other.userId, other.name, match.stake);
  scheduleSave();
}

function pvpPayAndStart(match) {
  if (!match || match.status !== 'confirming' || match.paid) return;
  const s = match.stake;
  if (getCBalance(match.p1.userId) < s || getCBalance(match.p2.userId) < s) {
    pvpDropMatch(match);
    scheduleSave();
    return;
  }
  creditCBalance(match.p1.userId, -s);
  creditCBalance(match.p2.userId, -s);
  match.paid = true;
  match.bank = s * 2;
  match.status = 'ready_wait';
  match.turn = null;
  match.p1.ready = false;
  match.p2.ready = false;
  match.p1.lastSeen = Date.now();
  match.p2.lastSeen = Date.now();
  scheduleSave();
}

function pvpBeginP1(match) {
  match.status = 'p1_playing';
  match.turn = 'p1';
  match.p1Deadline = Date.now() + PVP_TURN_MS;
  match.p1.lastSeen = Date.now();
  match.p2.lastSeen = Date.now();
  scheduleSave();
}

function pvpFinishForfeit(match, loserId) {
  if (!match || match.status === 'done') return;
  loserId = String(loserId);
  const winnerIsP1 = match.p1.userId !== loserId;
  const winner = winnerIsP1 ? match.p1 : match.p2;
  const prize = match.paid ? match.bank : 0;
  match.forfeit = true;
  match.winner = winnerIsP1 ? 'p1' : 'p2';
  match.winnerPrize = prize;
  if (prize) creditCBalance(winner.userId, prize);
  match.status = 'done';
  match.turn = null;
  match.resultUntil = Date.now() + 3 * 60 * 1000;
  scheduleSave();
}

function pvpResolve(match) {
  const s1 = Number(match.p1.score) || 0;
  const s2 = Number(match.p2.score) || 0;
  const house = Math.floor(match.bank * 0.1);
  const prize = match.bank - house;
  pvpHouseC += house;
  if (s1 > s2) {
    match.winner = 'p1';
    match.winnerPrize = prize;
    creditCBalance(match.p1.userId, prize);
  } else if (s2 > s1) {
    match.winner = 'p2';
    match.winnerPrize = prize;
    creditCBalance(match.p2.userId, prize);
  } else {
    match.winner = 'tie';
    const half = Math.floor(prize / 2);
    match.winnerPrize = half;
    creditCBalance(match.p1.userId, half);
    creditCBalance(match.p2.userId, prize - half);
  }
  match.status = 'done';
  match.turn = null;
  match.resultUntil = Date.now() + 3 * 60 * 1000;
  scheduleSave();
}

function pvpSweepTimeouts() {
  const now = Date.now();
  for (const match of Array.from(pvpMatches.values())) {
    if (match.status === 'done') {
      if (match.resultUntil && now > match.resultUntil) pvpDropMatch(match);
      continue;
    }
    if (match.status === 'confirming' && match.confirmUntil && now >= match.confirmUntil) {
      pvpPayAndStart(match);
      continue;
    }
    if (match.status === 'ready_wait') {
      const afk1 = match.p1.lastSeen && now - match.p1.lastSeen > PVP_AFK_MS && !match.p1.ready;
      const afk2 = match.p2.lastSeen && now - match.p2.lastSeen > PVP_AFK_MS && !match.p2.ready;
      if (afk1) pvpFinishForfeit(match, match.p1.userId);
      else if (afk2) pvpFinishForfeit(match, match.p2.userId);
      continue;
    }
    if (match.status === 'p1_playing' && match.p1.score == null) {
      const afk = match.p1.lastSeen && now - match.p1.lastSeen > PVP_AFK_MS;
      const late = match.p1Deadline && now > match.p1Deadline;
      if (afk || late) pvpFinishForfeit(match, match.p1.userId);
    } else if (match.status === 'p2_playing' && match.p2.score == null) {
      const afk = match.p2.lastSeen && now - match.p2.lastSeen > PVP_AFK_MS;
      const late = match.p2Deadline && now > match.p2Deadline;
      if (afk || late) pvpFinishForfeit(match, match.p2.userId);
    }
  }
}

function pvpJoin(userId, name, stake) {
  userId = String(userId);
  stake = Number(stake);
  if (PVP_STAKES.indexOf(stake) < 0) return { ok: false, error: 'invalid stake' };
  pvpSweepTimeouts();
  const existingId = pvpByUser.get(userId);
  if (existingId && pvpMatches.has(existingId)) {
    const m = pvpMatches.get(existingId);
    if (m.status && m.status !== 'done') return { ok: true, match: publicPvp(m, userId) };
    pvpByUser.delete(userId);
  }
  if (getCBalance(userId) < stake) return { ok: false, error: 'insufficient C' };

  for (const [st, list] of pvpQueue) {
    pvpQueue.set(st, (list || []).filter((x) => x.userId !== userId));
  }

  let q = (pvpQueue.get(stake) || []).filter((x) => Date.now() - x.joinedAt < 10 * 60 * 1000 && x.userId !== userId);
  if (q.length) {
    const idx = Math.floor(Math.random() * q.length);
    const opp = q.splice(idx, 1)[0];
    pvpQueue.set(stake, q);
    if (getCBalance(userId) < stake || getCBalance(opp.userId) < stake) {
      return { ok: false, error: 'insufficient C' };
    }
    const now = Date.now();
    const match = {
      id: newPvpId(),
      stake,
      bank: stake * 2,
      paid: false,
      p1: { userId, name: name || 'Player', score: null, lastSeen: now },
      p2: { userId: String(opp.userId), name: opp.name || 'Player', score: null, lastSeen: now },
      turn: null,
      status: 'confirming',
      createdAt: now,
      confirmUntil: now + PVP_CONFIRM_MS,
    };
    pvpMatches.set(match.id, match);
    pvpByUser.set(userId, match.id);
    pvpByUser.set(String(opp.userId), match.id);
    scheduleSave();
    return { ok: true, match: publicPvp(match, userId) };
  }
  q.push({ userId, name: name || 'Player', joinedAt: Date.now() });
  pvpQueue.set(stake, q);
  return { ok: true, waiting: true, stake, cBalance: getCBalance(userId) };
}

function pvpCancel(userId) {
  userId = String(userId);
  for (const [st, list] of pvpQueue) {
    pvpQueue.set(st, (list || []).filter((x) => x.userId !== userId));
  }
  return { ok: true, cBalance: getCBalance(userId) };
}

function pvpDecline(userId) {
  userId = String(userId);
  pvpSweepTimeouts();
  const id = pvpByUser.get(userId);
  if (id && pvpMatches.has(id)) {
    const m = pvpMatches.get(id);
    if (m.status === 'confirming' && !m.paid) pvpAbortConfirm(m, userId);
  }
  pvpCancel(userId);
  return { ok: true, idle: true, cBalance: getCBalance(userId) };
}

function pvpReady(userId) {
  userId = String(userId);
  pvpSweepTimeouts();
  const id = pvpByUser.get(userId);
  if (!id || !pvpMatches.has(id)) return { ok: false, error: 'no match' };
  const match = pvpMatches.get(id);
  if (match.status === 'confirming') pvpPayAndStart(match);
  if (match.status !== 'ready_wait') return { ok: true, match: publicPvp(match, userId) };
  if (match.p1.userId === userId) match.p1.ready = true;
  if (match.p2.userId === userId) match.p2.ready = true;
  match.p1.lastSeen = match.p1.userId === userId ? Date.now() : match.p1.lastSeen;
  match.p2.lastSeen = match.p2.userId === userId ? Date.now() : match.p2.lastSeen;
  if (match.p1.ready && match.p2.ready) pvpBeginP1(match);
  else scheduleSave();
  return { ok: true, match: publicPvp(match, userId) };
}

function pvpAck(userId) {
  userId = String(userId);
  const id = pvpByUser.get(userId);
  if (id && pvpMatches.has(id)) {
    const m = pvpMatches.get(id);
    if (m.status === 'done') pvpByUser.delete(userId);
  }
  return { ok: true, idle: true, cBalance: getCBalance(userId) };
}

function pvpForfeit(userId) {
  userId = String(userId);
  pvpSweepTimeouts();
  const id = pvpByUser.get(userId);
  if (!id || !pvpMatches.has(id)) return { ok: true, idle: true, cBalance: getCBalance(userId) };
  const m = pvpMatches.get(id);
  if (m.status === 'done') return { ok: true, match: publicPvp(m, userId) };
  if (m.status === 'confirming' && !m.paid) {
    pvpAbortConfirm(m, userId);
    return { ok: true, idle: true, cBalance: getCBalance(userId) };
  }
  if (m.paid && (m.status === 'p1_playing' || m.status === 'p2_playing' || m.status === 'ready_wait')) {
    pvpFinishForfeit(m, userId);
    return { ok: true, match: publicPvp(m, userId) };
  }
  return { ok: true, match: publicPvp(m, userId) };
}

function pvpHeartbeat(userId) {
  userId = String(userId);
  pvpSweepTimeouts();
  const id = pvpByUser.get(userId);
  if (id && pvpMatches.has(id)) {
    const m = pvpMatches.get(id);
    if (m.p1.userId === userId) m.p1.lastSeen = Date.now();
    if (m.p2.userId === userId) m.p2.lastSeen = Date.now();
    return { ok: true, match: publicPvp(m, userId) };
  }
  return pvpStatus(userId);
}

function pvpStatus(userId) {
  userId = String(userId);
  pvpSweepTimeouts();
  const id = pvpByUser.get(userId);
  if (id && pvpMatches.has(id)) return { ok: true, match: publicPvp(pvpMatches.get(id), userId) };
  for (const [st, list] of pvpQueue) {
    if ((list || []).some((x) => x.userId === userId)) {
      return { ok: true, waiting: true, stake: st, cBalance: getCBalance(userId) };
    }
  }
  return { ok: true, idle: true, cBalance: getCBalance(userId) };
}

function parseRefCode(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  try { s = decodeURIComponent(s); } catch (e) {}
  s = s.trim();
  const mStart = s.match(/[?&#]startapp=([^&#]+)/i) || s.match(/startapp=([^&#]+)/i);
  if (mStart) {
    try { s = decodeURIComponent(mStart[1]); } catch (e) { s = mStart[1]; }
  }
  s = s.split(/[?#&/]/)[0].trim();
  if (/^ref[_-]?/i.test(s) || /^\d+$/.test(s)) return s;
  const mRef = s.match(/ref[_-]?\d+/i);
  return mRef ? mRef[0] : s;
}

function ensureReferral(userId, name) {
  userId = String(userId);
  let rec = referralByUser.get(userId);
  if (!rec) {
    const code = 'ref_' + userId;
    rec = { code, referredBy: null, name: name || 'Player', invited: [], earned: 0 };
    referralByUser.set(userId, rec);
    referralCodeIndex.set(code.toLowerCase(), userId);
    scheduleSave();
  } else if (name && rec.name !== name) {
    rec.name = name;
  }
  if (!referralCodeIndex.has(String(rec.code).toLowerCase())) {
    referralCodeIndex.set(String(rec.code).toLowerCase(), userId);
  }
  return rec;
}

function attachReferral(userId, name, startParam) {
  userId = String(userId);
  const rec = ensureReferral(userId, name);
  if (rec.referredBy) return rec;
  const code = parseRefCode(startParam);
  if (!code) return rec;
  let referrerId = referralCodeIndex.get(code.toLowerCase());
  if (!referrerId && /^ref[_-]?(\d+)$/i.test(code)) {
    referrerId = code.replace(/^ref[_-]?/i, '');
    ensureReferral(referrerId, 'Player');
    referrerId = referralCodeIndex.get(('ref_' + referrerId).toLowerCase()) || referrerId;
  }
  if (!referrerId || String(referrerId) === userId) return rec;

  let walk = String(referrerId);
  for (let i = 0; i < 20 && walk; i++) {
    if (walk === userId) return rec;
    const up = referralByUser.get(walk);
    walk = up && up.referredBy ? String(up.referredBy) : '';
  }

  rec.referredBy = String(referrerId);
  rec.name = name || rec.name;
  const parent = ensureReferral(referrerId, 'Player');
  if (!parent.invited.some((x) => x.id === userId)) {
    parent.invited.push({ id: userId, name: rec.name, at: Date.now() });
    const day = currentDayKey();
    if (!dailyInvites.has(day)) dailyInvites.set(day, new Map());
    const board = dailyInvites.get(day);
    const prev = board.get(String(referrerId)) || { name: parent.name, count: 0 };
    prev.count += 1;
    prev.name = parent.name || prev.name;
    board.set(String(referrerId), prev);
  }
  scheduleSave();
  return rec;
}

function invitedOf(userId) {
  const rec = referralByUser.get(String(userId));
  return rec && Array.isArray(rec.invited) ? rec.invited : [];
}

function getReferralInfo(userId, name) {
  const rec = ensureReferral(userId, name);
  const people1 = rec.invited.slice();
  let level2 = 0;
  let level3 = 0;
  for (const p of people1) {
    const kids = invitedOf(p.id);
    level2 += kids.length;
    for (const k of kids) level3 += invitedOf(k.id).length;
  }
  return {
    code: rec.code,
    level1: people1.length,
    level2,
    level3,
    earned: rec.earned || 0,
    people1: people1.map((x) => ({ id: x.id, name: x.name })),
  };
}

function getReferralLeaderboardDay(limit) {
  const board = dailyInvites.get(currentDayKey()) || new Map();
  const entries = Array.from(board.entries())
    .map(([userId, v]) => ({ userId, name: v.name || 'Player', invites: v.count || 0 }))
    .filter((e) => e.invites > 0)
    .sort((a, b) => b.invites - a.invites)
    .slice(0, limit || 20)
    .map((e, i) => Object.assign({ rank: i + 1 }, e));
  return entries;
}

function creditReferralCommissions(userId, amount) {
  amount = Number(amount) || 0;
  if (!(amount > 0)) return;
  const rates = [0.07, 0.03, 0.01];
  let uid = String(userId);
  for (let i = 0; i < rates.length; i++) {
    const rec = referralByUser.get(uid);
    const parentId = rec && rec.referredBy ? String(rec.referredBy) : '';
    if (!parentId) break;
    const pay = Math.floor(amount * rates[i]);
    if (pay > 0) {
      creditCBalance(parentId, pay);
      const parent = ensureReferral(parentId, 'Player');
      parent.earned = (parent.earned || 0) + pay;
    }
    uid = parentId;
  }
}

function pvpSubmitScore(userId, score) {
  userId = String(userId);
  score = Math.max(0, Math.floor(Number(score) || 0));
  pvpSweepTimeouts();
  const id = pvpByUser.get(userId);
  if (!id || !pvpMatches.has(id)) return { ok: false, error: 'no match' };
  const match = pvpMatches.get(id);
  if (match.status === 'done') return { ok: true, match: publicPvp(match, userId) };
  if (match.status === 'p1_playing' && match.p1.userId === userId && match.p1.score == null) {
    match.p1.score = score;
    match.p1.lastSeen = Date.now();
    match.status = 'p2_playing';
    match.turn = 'p2';
    match.p2Deadline = Date.now() + PVP_TURN_MS;
    match.p2.lastSeen = Date.now();
    scheduleSave();
    return { ok: true, match: publicPvp(match, userId) };
  }
  if (match.status === 'p2_playing' && match.p2.userId === userId && match.p2.score == null) {
    match.p2.score = score;
    match.p2.lastSeen = Date.now();
    pvpResolve(match);
    return { ok: true, match: publicPvp(match, userId) };
  }
  return { ok: false, error: 'not your turn' };
}

module.exports = {
  currentDayKey, currentWeekKey, currentMonthKey, periodKey,
  createSession, getSession, consumeSession,
  submitPeriodScores, submitWeeklyScore, getLeaderboard, getUserRank,
  allowRequest,
  archiveWeek,
  rewardHistory,
  updateAllTimeBest, getAllTimeBest,
  getBalance, creditBalance, getCBalance, creditCBalance,
  requestWithdrawal, listWithdrawals, markWithdrawalPaid,
  requestDeposit, listDeposits, approveDeposit, rejectDeposit,
  trackUser, getTotalUsers, getActivePlayers, recordRun, getRunStats,
  pvpJoin, pvpCancel, pvpDecline, pvpReady, pvpAck, pvpForfeit, pvpHeartbeat, pvpStatus, pvpSubmitScore, PVP_STAKES,
  attachReferral, getReferralInfo, getReferralLeaderboardDay,
  dataFile: DATA_FILE,
  ready,
  flush: saveNow,
  getSnapshot: snapshot,
  importSnapshot: function(data) {
    hydrate(data);
    saveNow();
    return {
      players: allTimeBest.size,
      boards: periodBoards.size,
      withdrawals: withdrawals.length,
      deposits: deposits.length,
    };
  },
  persistInfo: function() {
    let bytes = 0;
    let exists = false;
    try {
      if (fs.existsSync(DATA_FILE)) {
        exists = true;
        bytes = fs.statSync(DATA_FILE).size;
      }
    } catch (e) {}
    return {
      dataFile: DATA_FILE,
      exists,
      bytes,
      redis: useRedis,
      backend: useRedis ? 'upstash-redis' : 'file',
      players: allTimeBest.size,
      boards: periodBoards.size,
    };
  },
};
