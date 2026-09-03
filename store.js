/**
 * Player data store.
 *
 * Prefers Upstash Redis when UPSTASH_REDIS_REST_URL + TOKEN are set
 * (survives every GitHub / Railway deploy). Falls back to DATA_FILE.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'store.json');
const FALLBACK_FILE = path.join(__dirname, 'data', 'store.json');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(DATA_FILE), 'backups');
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
const BACKUP_PREFIX = REDIS_KEY + ':bak:';
const BACKUP_INDEX_KEY = REDIS_KEY + ':bakindex';
const useRedis = !!(UPSTASH_URL && UPSTASH_TOKEN);

// --- data-safety configuration -------------------------------------------
// How often an automatic snapshot backup is taken (default: 1 hour).
const BACKUP_EVERY_MS = Math.max(60 * 1000, Number(process.env.BACKUP_EVERY_MS) || 60 * 60 * 1000);
// How many rolling backups to keep (Redis + local files).
const BACKUP_KEEP = Math.max(3, Number(process.env.BACKUP_KEEP) || 48);
// TTL for a backup key in Redis (default 30 days).
const BACKUP_TTL_SEC = Math.max(3600, Number(process.env.BACKUP_TTL_SEC) || 30 * 24 * 3600);
// Refuse to overwrite storage if the player count would drop below this
// fraction of the previously known count (protects against a bad deploy /
// failed load wiping everybody's balance + leaderboard).
const SHRINK_GUARD_RATIO = Number(process.env.SHRINK_GUARD_RATIO) || 0.5;
// How often we re-check whether another instance wrote newer data.
const CONFLICT_CHECK_MS = Math.max(2000, Number(process.env.CONFLICT_CHECK_MS) || 15000);

// Unique id of this process — lets us detect "another container wrote after us".
const INSTANCE_ID = crypto.randomBytes(8).toString('hex');
// 'pending' until the initial load finished. Saving before/without a
// successful load is what destroys data, so it is hard-blocked.
let loadState = 'pending';
let loadError = null;
let peakKnownUsers = 0;      // biggest player count we ever held/saw
let lastBackupAt = 0;
let lastConflictCheckAt = 0;
let lastRemoteSavedAt = 0;   // savedAt of the snapshot we know is in Redis
let lastSaveOkAt = 0;
let lastSaveError = null;
let blockedSaves = 0;
let fileSaveFailStreak = 0;   // consecutive failed writes to DATA_FILE (log throttling)
// Unknown top-level fields from a snapshot written by a NEWER version of the
// code are kept verbatim, so rolling back a deploy never deletes new data.
let extraFields = {};

const sessions = new Map();       // sessionId -> { userId, seed, startedAt, used, ... }
const bans = new Map();           // userId -> { until, reason, strikes }
const antiCheatEvents = [];       // recent rejects (capped)
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
// Small admin-only directory used to map a Telegram user ID to the name that
// was received from Telegram. The ID remains the source of truth for bans;
// this is only a convenience so an admin does not have to guess it.
const userDirectory = new Map(); // userId -> { name, username, firstSeen, lastSeen }
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

function previousWeekKey(d = new Date()) {
  return currentWeekKey(new Date(d.getTime() - 7 * 24 * 3600 * 1000));
}

function weekAlreadyPaid(weekKey) {
  return rewardHistory.some((r) => r && r.weekKey === String(weekKey));
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
  const users = {};
  for (const [uid, row] of userDirectory) users[String(uid)] = row;
  return Object.assign({}, extraFields, {
    version: 2,
    savedAt: Date.now(),
    savedBy: INSTANCE_ID,
    periodBoards: boards,
    allTimeBest: best,
    balances: bals,
    cBalances: cBals,
    withdrawals,
    withdrawalSeq,
    deposits,
    depositSeq,
    knownUsers: Array.from(knownUsers).map(String),
    users,
    totalRuns,
    rewardHistory,
    pvpMatches: Array.from(pvpMatches.values()),
    pvpHouseC,
    pvpQueue: (function () {
      const out = {};
      for (const [stake, list] of pvpQueue) out[String(stake)] = list;
      return out;
    })(),
    referrals: Object.fromEntries(Array.from(referralByUser.entries()).map(([uid, row]) => [uid, row])),
    bans: Object.fromEntries(Array.from(bans.entries()).map(([uid, row]) => [uid, row])),
    antiCheatEvents: antiCheatEvents.slice(-200),
    dailyInvites: (function () {
      const out = {};
      for (const [day, m] of dailyInvites) {
        const rows = {};
        for (const [uid, row] of m) rows[uid] = row;
        out[day] = rows;
      }
      return out;
    })(),
  });
}

const KNOWN_SNAPSHOT_FIELDS = new Set([
  'version', 'savedAt', 'savedBy', 'periodBoards', 'allTimeBest', 'balances', 'cBalances',
  'withdrawals', 'withdrawalSeq', 'deposits', 'depositSeq', 'knownUsers', 'users', 'totalRuns',
  'rewardHistory', 'pvpMatches', 'pvpHouseC', 'pvpQueue', 'referrals', 'dailyInvites',
  'bans', 'antiCheatEvents',
]);

function hydrate(data) {
  if (!data || typeof data !== 'object') return;

  // Keep every field this version of the code does not understand, so that
  // deploying older code (or a rollback) can never delete data written by a
  // newer version.
  extraFields = {};
  for (const key of Object.keys(data)) {
    if (!KNOWN_SNAPSHOT_FIELDS.has(key)) extraFields[key] = data[key];
  }

  periodBoards.clear();
  const boards = data.periodBoards || {};
  for (const key of Object.keys(boards)) {
    const m = new Map();
    const rows = boards[key] || {};
    for (const uid of Object.keys(rows)) {
      const row = rows[uid];
      if (row && Number.isFinite(row.score)) {
        m.set(String(uid), Object.assign({}, row, {
          name: row.name || 'Player',
          score: row.score,
          updatedAt: row.updatedAt || 0,
        }));
      }
    }
    periodBoards.set(key, m);
  }

  allTimeBest.clear();
  const best = data.allTimeBest || {};
  for (const uid of Object.keys(best)) {
    const row = best[uid];
    if (row && Number.isFinite(row.score)) {
      allTimeBest.set(String(uid), Object.assign({}, row, { name: row.name || 'Player', score: row.score }));
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

  userDirectory.clear();
  const usersIn = data.users || {};
  if (usersIn && typeof usersIn === 'object' && !Array.isArray(usersIn)) {
    for (const uid of Object.keys(usersIn)) {
      const row = usersIn[uid];
      if (!row || typeof row !== 'object') continue;
      userDirectory.set(String(uid), {
        name: String(row.name || 'Player').slice(0, 120),
        username: String(row.username || '').slice(0, 64),
        firstSeen: Number(row.firstSeen) || 0,
        lastSeen: Number(row.lastSeen) || 0,
      });
      knownUsers.add(String(uid));
    }
  }

  totalRuns = Number(data.totalRuns) || 0;

  rewardHistory.length = 0;
  if (Array.isArray(data.rewardHistory)) {
    for (const row of data.rewardHistory) rewardHistory.push(row);
  }

  pvpMatches.clear();
  pvpByUser.clear();
  pvpQueue.clear();
  pvpHouseC = Math.max(0, Math.floor(Number(data.pvpHouseC) || 0));
  if (Array.isArray(data.pvpMatches)) {
    const now = Date.now();
    for (const m of data.pvpMatches) {
      if (m && m.id && m.status !== 'done') {
        if (m.p1) m.p1.lastSeen = now;
        if (m.p2) m.p2.lastSeen = now;
        pvpMatches.set(m.id, m);
        if (m.p1 && m.p1.userId) pvpByUser.set(String(m.p1.userId), m.id);
        if (m.p2 && m.p2.userId) pvpByUser.set(String(m.p2.userId), m.id);
      }
    }
  }
  const qIn = data.pvpQueue || {};
  for (const key of Object.keys(qIn)) {
    const stake = Number(key);
    const list = Array.isArray(qIn[key]) ? qIn[key] : [];
    const cleaned = list
      .filter((x) => x && x.userId && !pvpByUser.has(String(x.userId)))
      .map((x) => ({ userId: String(x.userId), name: x.name || 'Player', joinedAt: x.joinedAt || Date.now() }));
    if (cleaned.length) pvpQueue.set(stake, cleaned);
  }

  referralByUser.clear();
  referralCodeIndex.clear();
  const refs = data.referrals || {};
  for (const uid of Object.keys(refs)) {
    const row = refs[uid];
    if (!row || typeof row !== 'object') continue;
    const userId = String(uid);
    const rec = Object.assign({}, row, {
      code: row.code || ('ref_' + userId),
      referredBy: row.referredBy ? String(row.referredBy) : null,
      name: row.name || 'Player',
      invited: Array.isArray(row.invited)
        ? row.invited.filter(Boolean).map((x) => ({
            id: String(x.id),
            name: x.name || 'Player',
            at: x.at || 0,
          }))
        : [],
      earned: Number(row.earned) || 0,
    });
    referralByUser.set(userId, rec);
    referralCodeIndex.set(String(rec.code).toLowerCase(), userId);
    referralCodeIndex.set(('ref_' + userId).toLowerCase(), userId);
  }

  bans.clear();
  const banIn = data.bans || {};
  for (const uid of Object.keys(banIn)) {
    const row = banIn[uid];
    if (!row || typeof row !== 'object') continue;
    bans.set(String(uid), {
      until: Number(row.until) || 0,
      reason: String(row.reason || 'cheat').slice(0, 120),
      strikes: Math.max(0, Number(row.strikes) || 0),
      windowStart: Number(row.windowStart) || 0,
    });
  }
  antiCheatEvents.length = 0;
  if (Array.isArray(data.antiCheatEvents)) {
    for (const ev of data.antiCheatEvents.slice(-200)) {
      if (ev && typeof ev === 'object') antiCheatEvents.push(ev);
    }
  }

  dailyInvites.clear();
  const days = data.dailyInvites || {};
  for (const day of Object.keys(days)) {
    const m = new Map();
    const rows = days[day] || {};
    for (const uid of Object.keys(rows)) {
      const row = rows[uid];
      m.set(String(uid), {
        name: (row && row.name) || 'Player',
        count: Number(row && row.count) || 0,
      });
    }
    dailyInvites.set(day, m);
  }
}

function writeJsonFile(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * Returns a human-readable description when DATA_FILE currently exists as a
 * DIRECTORY instead of a file, or null when the path is fine.
 *
 * This is a classic Railway/volume mistake: if a folder accidentally appears
 * at /data/store.json (an accidental mkdir / upload / archive extraction, a
 * shell mistake, an old tool writing a directory layout, …), the atomic
 * save (write store.json.tmp then rename to store.json) fails forever with
 * "EISDIR: illegal operation on a directory, rename …". The container keeps
 * working from memory + the ephemeral fallback file, so every redeploy then
 * silently reverts player data to the last hourly backup — balances,
 * referrals and leaderboard rows look "deleted".
 */
function dataFileProblem() {
  try {
    const st = fs.statSync(DATA_FILE);
    if (st.isDirectory()) {
      return 'DATA_FILE (' + DATA_FILE + ') is a DIRECTORY, not a file — every save fails with EISDIR. ' +
        'Move it out of the way (e.g. `mv ' + DATA_FILE + ' ' + DATA_FILE + '.dir-bak`) so the app can write a normal file there.';
    }
  } catch (e) { /* path missing or unreadable — not the directory problem */ }
  return null;
}

/**
 * The Railway-specific recipe for the DATA_FILE-is-a-directory problem.
 *
 * The overwhelmingly common cause is not a stray `mkdir` at all: the Volume
 * itself was mounted AT /data/store.json. A mount point is ALWAYS a directory
 * and can never hold a file — and, unlike an ordinary directory, it cannot
 * even be renamed aside. So the self-heal below will fail and every save will
 * keep dying with EISDIR until the mount configuration is corrected. Spell the
 * exact settings out, because "move it aside" is not actionable in that case.
 */
function dataFileMountHint() {
  const parent = path.dirname(DATA_FILE);
  // A bare filename (DATA_FILE=store.json) would otherwise tell the operator to
  // mount the volume at "/", which is nonsense — recommend /data instead.
  const mountPath = (parent === '/' || parent === '' || parent === '.') ? '/data' : parent;
  return 'On Railway this usually means the Volume is mounted DIRECTLY at ' + DATA_FILE +
    ' (a mount point can never become a file). Fix: Service → Settings → Volumes → ' +
    'set the volume Mount Path to ' + mountPath + ' (NOT ' + DATA_FILE + '), keep the ' +
    'variable DATA_FILE=' + DATA_FILE + ', then redeploy.';
}

/**
 * Self-heal for the DATA_FILE-is-a-directory problem: rename the directory
 * aside (its contents are preserved) so a real file can be written at
 * DATA_FILE again.
 *
 * Returns:
 *   string — the NEW path the directory was renamed to (healed),
 *   false  — it IS a directory but could not be moved (e.g. it is the volume
 *            mount point itself; the operator must fix the mount),
 *   null   — nothing to heal.
 */
function relocateDataFileAside() {
  const problem = dataFileProblem();
  if (!problem) return null;
  const moved = DATA_FILE + '.dir-' + new Date().toISOString().replace(/[:.]/g, '-');
  try {
    fs.renameSync(DATA_FILE, moved);
    console.error('store: ' + problem);
    console.error('store: auto-fixed — renamed the directory to ' + moved +
      '\n       the app will now create a real file at ' + DATA_FILE + '.' +
      '\n       check whether ' + moved + ' contains anything you need (old data / backups).');
    return moved;
  } catch (err) {
    console.error('store: ' + problem);
    console.error('store: auto-rename FAILED (' + (err.message || err) + ') — reads and writes to ' +
      DATA_FILE + ' will keep failing until that path is a normal file.');
    console.error('store: ' + dataFileMountHint());
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Data-safety helpers
 * ------------------------------------------------------------------ */

function countPlayers(snap) {
  const users = new Set();
  for (const uid of snap.knownUsers || []) users.add(String(uid));
  for (const uid of Object.keys(snap.allTimeBest || {})) users.add(String(uid));
  for (const uid of Object.keys(snap.balances || {})) users.add(String(uid));
  for (const uid of Object.keys(snap.cBalances || {})) users.add(String(uid));
  for (const uid of Object.keys(snap.referrals || {})) users.add(String(uid));
  for (const uid of Object.keys(snap.users || {})) users.add(String(uid));
  return users.size;
}

function snapshotHasPlayers(snap) {
  return !!(
    (snap.knownUsers && snap.knownUsers.length) ||
    (snap.allTimeBest && Object.keys(snap.allTimeBest).length) ||
    (snap.balances && Object.keys(snap.balances).length) ||
    snap.totalRuns
  );
}

function parseSnapshot(raw) {
  if (!raw) return null;
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return data;
}

/**
 * Merge two snapshots so that NO player is ever lost.
 * `base` wins on conflicts (it is the newer side); anything that exists only
 * in `other` is added back, and numeric progress takes the safer/larger value.
 * Used when two containers overlap during a deploy.
 */
function mergeSnapshots(base, other) {
  if (!other) return base;
  if (!base) return other;
  const out = JSON.parse(JSON.stringify(base));

  // unknown (newer-version) fields
  for (const key of Object.keys(other)) {
    if (!(key in out)) out[key] = other[key];
  }

  // all-time best: keep the highest score
  out.allTimeBest = out.allTimeBest || {};
  for (const [uid, row] of Object.entries(other.allTimeBest || {})) {
    const cur = out.allTimeBest[uid];
    if (!cur || (Number(row && row.score) || 0) > (Number(cur.score) || 0)) out.allTimeBest[uid] = row;
  }

  // period leaderboards: keep the highest score per period + user
  out.periodBoards = out.periodBoards || {};
  for (const [pkey, rows] of Object.entries(other.periodBoards || {})) {
    if (!out.periodBoards[pkey]) { out.periodBoards[pkey] = rows; continue; }
    for (const [uid, row] of Object.entries(rows || {})) {
      const cur = out.periodBoards[pkey][uid];
      if (!cur || (Number(row && row.score) || 0) > (Number(cur.score) || 0)) out.periodBoards[pkey][uid] = row;
    }
  }

  // balances: never invent money — only restore users missing on the base side
  for (const field of ['balances', 'cBalances']) {
    out[field] = out[field] || {};
    for (const [uid, n] of Object.entries(other[field] || {})) {
      if (!(uid in out[field]) && Number.isFinite(Number(n))) out[field][uid] = Number(n);
    }
  }

  // withdrawals / deposits: union by id, base wins on the same id
  for (const field of ['withdrawals', 'deposits']) {
    const byId = new Map();
    for (const row of other[field] || []) if (row && row.id != null) byId.set(String(row.id), row);
    for (const row of out[field] || []) if (row && row.id != null) byId.set(String(row.id), row);
    out[field] = Array.from(byId.values()).sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
  }
  out.withdrawalSeq = Math.max(Number(out.withdrawalSeq) || 1, Number(other.withdrawalSeq) || 1);
  out.depositSeq = Math.max(Number(out.depositSeq) || 1, Number(other.depositSeq) || 1);

  // users / counters
  const users = new Set([...(out.knownUsers || []), ...(other.knownUsers || [])].map(String));
  out.knownUsers = Array.from(users);
  out.users = out.users || {};
  for (const [uid, row] of Object.entries(other.users || {})) {
    const cur = out.users[uid];
    if (!cur) {
      out.users[uid] = row;
      continue;
    }
    // Keep the freshest display data while retaining the earliest sighting.
    if ((Number(row && row.lastSeen) || 0) >= (Number(cur.lastSeen) || 0)) {
      if (row && row.name) cur.name = row.name;
      if (row && row.username) cur.username = row.username;
    }
    if (!cur.firstSeen || (Number(row && row.firstSeen) || 0) < cur.firstSeen) {
      cur.firstSeen = Number(row && row.firstSeen) || cur.firstSeen || 0;
    }
    cur.lastSeen = Math.max(Number(cur.lastSeen) || 0, Number(row && row.lastSeen) || 0);
  }
  for (const uid of Object.keys(out.users)) users.add(String(uid));
  out.knownUsers = Array.from(users);
  out.totalRuns = Math.max(Number(out.totalRuns) || 0, Number(other.totalRuns) || 0);
  out.pvpHouseC = Math.max(Number(out.pvpHouseC) || 0, Number(other.pvpHouseC) || 0);

  // reward history: union
  const seenReward = new Set((out.rewardHistory || []).map((r) => JSON.stringify([r && r.weekKey, r && r.archivedAt])));
  out.rewardHistory = out.rewardHistory || [];
  for (const r of other.rewardHistory || []) {
    const sig = JSON.stringify([r && r.weekKey, r && r.archivedAt]);
    if (!seenReward.has(sig)) { seenReward.add(sig); out.rewardHistory.push(r); }
  }

  // referrals: union of invited lists, best earned value
  out.referrals = out.referrals || {};
  for (const [uid, row] of Object.entries(other.referrals || {})) {
    const cur = out.referrals[uid];
    if (!cur) { out.referrals[uid] = row; continue; }
    const invited = new Map();
    for (const x of row && row.invited ? row.invited : []) if (x && x.id != null) invited.set(String(x.id), x);
    for (const x of cur.invited || []) if (x && x.id != null) invited.set(String(x.id), x);
    cur.invited = Array.from(invited.values());
    cur.earned = Math.max(Number(cur.earned) || 0, Number(row.earned) || 0);
    cur.referredBy = cur.referredBy || row.referredBy || null;
    cur.code = cur.code || row.code;
  }

  // daily invite counts: keep the larger count
  out.dailyInvites = out.dailyInvites || {};
  for (const [day, rows] of Object.entries(other.dailyInvites || {})) {
    if (!out.dailyInvites[day]) { out.dailyInvites[day] = rows; continue; }
    for (const [uid, row] of Object.entries(rows || {})) {
      const cur = out.dailyInvites[day][uid];
      if (!cur || (Number(row && row.count) || 0) > (Number(cur.count) || 0)) out.dailyInvites[day][uid] = row;
    }
  }

  return out;
}

/**
 * Last line of defence before any write: never persist a state that was not
 * loaded correctly, and never let the player count collapse.
 * Returns null when the write is allowed, or a reason string when blocked.
 */
function saveBlockedReason(snap, force) {
  if (loadState !== 'ok') {
    return 'initial load did not succeed (' + loadState + ') — refusing to overwrite live data';
  }
  if (force) return null;
  const players = countPlayers(snap);
  if (peakKnownUsers >= 5 && players < Math.ceil(peakKnownUsers * SHRINK_GUARD_RATIO)) {
    return `player count dropped ${peakKnownUsers} -> ${players} (shrink guard)`;
  }
  if (players > peakKnownUsers) peakKnownUsers = players;
  return null;
}

function saveFile(force) {
  const snap = snapshot();
  const blocked = saveBlockedReason(snap, force);
  if (blocked) {
    blockedSaves++;
    if (blockedSaves <= 3 || blockedSaves % 50 === 0) console.error('store: SAVE BLOCKED —', blocked);
    return false;
  }
  const json = JSON.stringify(snap);
  // Returns whether the PRIMARY (durable) copy was written. A success on the
  // ephemeral fallback file alone must NOT count — that file dies with the
  // container on every redeploy (that is exactly how data used to get lost
  // silently when DATA_FILE was misconfigured, e.g. pointed at a directory).
  let primaryOk = false;
  try {
    writeJsonFile(DATA_FILE, json);
    primaryOk = true;
    fileSaveFailStreak = 0;
    lastSaveError = null;
  } catch (err) {
    fileSaveFailStreak++;
    lastSaveError = String(err.message || err);
    // Throttled: only the first few failures (and every 50th after that) are
    // logged, otherwise a broken volume would spam the log on every save.
    if (fileSaveFailStreak <= 3 || fileSaveFailStreak % 50 === 0) {
      console.error('store file save failed:', lastSaveError);
      // Usual culprit: DATA_FILE sits on top of a directory (the volume got
      // mounted AT the file). Try to self-heal it and immediately retry the
      // write once — if that works this deploy is durable again without a
      // restart, and the players who are online right now are not lost.
      const moved = relocateDataFileAside();
      if (moved) {
        try {
          writeJsonFile(DATA_FILE, json);
          primaryOk = true;
          fileSaveFailStreak = 0;
          lastSaveError = null;
          console.error('store: saved to ' + DATA_FILE + ' after the auto-fix — writes are durable again.');
        } catch (err2) {
          lastSaveError = String(err2.message || err2);
          console.error('store file save still failed after the auto-fix:', lastSaveError);
        }
      }
    }
  }
  if (path.resolve(FALLBACK_FILE) !== path.resolve(DATA_FILE)) {
    try { writeJsonFile(FALLBACK_FILE, json); } catch (e) {
      if (fileSaveFailStreak <= 3) console.error('store fallback file save failed:', e.message || e);
    }
  }
  return primaryOk;
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

/**
 * Live storage self-probe.
 *
 * "durable: true" in persistInfo() is only an educated guess from the env
 * (e.g. "an Upstash URL was set"). It does NOT prove the backend is actually
 * reachable or writable — a wrong token, a throttled key or a read-only volume
 * would still report durable. This probe does a real write + read (and delete)
 * round-trip against the ACTIVE backend and reports the truth, so the operator
 * can confirm before/after every deploy that player data really will survive.
 */
function durableLooksOk() {
  if (useRedis) return true;
  return /^\/(data|mnt|volume)/.test(path.resolve(DATA_FILE));
}

async function probeDurability() {
  const t0 = Date.now();
  if (useRedis) {
    const probeKey = REDIS_KEY + ':durprobe:' + INSTANCE_ID + ':' + Date.now();
    const val = 'alive-' + Date.now();
    try {
      await redisCmd(['SET', probeKey, val, 'EX', '120']);
      const got = await redisCmd(['GET', probeKey]);
      await redisCmd(['DEL', probeKey]).catch(() => {});
      return {
        ok: got === val,
        backend: 'upstash-redis',
        detail: got === val ? 'write + read round-trip ok' : 'read-back mismatch',
        durable: true,
        ms: Date.now() - t0,
      };
    } catch (err) {
      return {
        ok: false,
        backend: 'upstash-redis',
        durable: true,
        error: String((err && err.message) || err),
        ms: Date.now() - t0,
      };
    }
  }

  // File backend: confirm the directory is writable AND sits on a mount that
  // survives a redeploy (not the container's ephemeral root filesystem).
  try {
    // A temp file next to store.json proves the folder is writable, but it
    // would PASS even when store.json itself can never be written (e.g. it is
    // a directory and every save dies with EISDIR). Fail loudly on that — and
    // hand the operator the exact Railway settings that cause it.
    const pathProblem = dataFileProblem();
    if (pathProblem) {
      return {
        ok: false,
        backend: 'file',
        dataFile: DATA_FILE,
        durable: durableLooksOk(),
        error: pathProblem,
        hint: dataFileMountHint(),
        ms: Date.now() - t0,
      };
    }
    const dir = path.dirname(DATA_FILE);
    fs.mkdirSync(dir, { recursive: true });
    const probePath = path.join(dir, '__durability_probe__' + INSTANCE_ID + '.tmp');
    const payload = JSON.stringify({ t: Date.now(), i: INSTANCE_ID });
    fs.writeFileSync(probePath, payload, 'utf8');
    const read = fs.readFileSync(probePath, 'utf8');
    try { fs.unlinkSync(probePath); } catch (e) {}
    const ok = read === payload;
    const durable = durableLooksOk();
    return {
      ok,
      backend: 'file',
      dataFile: DATA_FILE,
      durable,
      detail: ok ? 'temp file write + read ok' : 'write/read mismatch',
      warning: durable
        ? null
        : 'This file is on the container\u2019s EPHEMERAL disk — it will be wiped on the next deploy. ' +
          'Mount a volume at /data (Railway) and set DATA_FILE=/data/store.json, or use Upstash Redis.',
      ms: Date.now() - t0,
    };
  } catch (err) {
    return {
      ok: false,
      backend: 'file',
      dataFile: DATA_FILE,
      durable: durableLooksOk(),
      error: String((err && err.message) || err),
      ms: Date.now() - t0,
    };
  }
}

/* ---------------------------- backups ---------------------------- */

function backupFileName(at = Date.now()) {
  return 'store-' + new Date(at).toISOString().replace(/[:.]/g, '-') + '.json';
}

function createFileBackup(snap) {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    writeJsonFile(path.join(BACKUP_DIR, backupFileName(snap.savedAt)), JSON.stringify(snap));
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('store-') && f.endsWith('.json')).sort();
    while (files.length > BACKUP_KEEP) {
      const old = files.shift();
      try { fs.unlinkSync(path.join(BACKUP_DIR, old)); } catch (e) {}
    }
    return true;
  } catch (err) {
    console.error('store: file backup failed:', err.message || err);
    return false;
  }
}

async function readBackupIndex() {
  try {
    const raw = await redisCmd(['GET', BACKUP_INDEX_KEY]);
    const list = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (err) {
    return [];
  }
}

async function createRedisBackup(snap, label) {
  const key = BACKUP_PREFIX + new Date(snap.savedAt).toISOString().replace(/[:.]/g, '-');
  await redisCmd(['SET', key, JSON.stringify(snap), 'EX', String(BACKUP_TTL_SEC)]);
  const index = await readBackupIndex();
  index.push({ key, at: snap.savedAt, players: countPlayers(snap), label: label || 'auto' });
  while (index.length > BACKUP_KEEP) {
    const old = index.shift();
    try { await redisCmd(['DEL', old.key]); } catch (e) {}
  }
  await redisCmd(['SET', BACKUP_INDEX_KEY, JSON.stringify(index)]);
  return { key, at: snap.savedAt, players: countPlayers(snap), label: label || 'auto' };
}

async function createBackup(label) {
  const snap = snapshot();
  if (!snapshotHasPlayers(snap)) return { ok: false, error: 'nothing to back up yet' };
  if (loadState !== 'ok') return { ok: false, error: 'store not loaded — backup skipped' };
  createFileBackup(snap);
  lastBackupAt = Date.now();
  if (!useRedis) return { ok: true, target: 'file', at: snap.savedAt, players: countPlayers(snap) };
  try {
    const info = await createRedisBackup(snap, label);
    return Object.assign({ ok: true, target: 'redis+file' }, info);
  } catch (err) {
    return { ok: false, error: String(err.message || err), target: 'file' };
  }
}

function maybeBackup() {
  if (loadState !== 'ok') return;
  if (Date.now() - lastBackupAt < BACKUP_EVERY_MS) return;
  lastBackupAt = Date.now();
  createBackup('auto')
    .then((r) => { if (r && r.ok) console.log('store: auto backup done —', r.players, 'players'); })
    .catch((err) => console.error('store: auto backup failed:', err.message || err));
}

async function listBackups() {
  const out = [];
  if (useRedis) {
    for (const row of await readBackupIndex()) {
      out.push({ id: row.key, source: 'redis', at: row.at, players: row.players, label: row.label || 'auto' });
    }
  }
  try {
    for (const f of fs.readdirSync(BACKUP_DIR).filter((x) => x.startsWith('store-') && x.endsWith('.json')).sort()) {
      const full = path.join(BACKUP_DIR, f);
      let at = 0;
      try { at = fs.statSync(full).mtimeMs; } catch (e) {}
      out.push({ id: 'file:' + f, source: 'file', at, players: null, label: 'file' });
    }
  } catch (e) {}
  return out.sort((a, b) => (b.at || 0) - (a.at || 0));
}

async function restoreBackup(id) {
  if (!id) return { ok: false, error: 'backup id required' };
  let data = null;
  if (String(id).startsWith('file:')) {
    const full = path.join(BACKUP_DIR, path.basename(String(id).slice(5)));
    data = parseSnapshot(fs.readFileSync(full, 'utf8'));
  } else {
    if (!useRedis) return { ok: false, error: 'redis not configured' };
    const rid = String(id);
    if (rid.indexOf(BACKUP_PREFIX) !== 0) return { ok: false, error: 'invalid backup id' };
    data = parseSnapshot(await redisCmd(['GET', rid]));
  }
  if (!data) return { ok: false, error: 'backup not found or unreadable' };
  // Safety net: snapshot the CURRENT state before replacing it.
  await createBackup('pre-restore').catch(() => {});
  hydrate(data);
  peakKnownUsers = countPlayers(snapshot());
  await saveAll(true);
  return { ok: true, players: allTimeBest.size, boards: periodBoards.size, restoredFrom: id };
}

/* ---------------------------- writing ---------------------------- */

async function saveRedis(force) {
  const snap = snapshot();
  const blocked = saveBlockedReason(snap, force);
  if (blocked) {
    blockedSaves++;
    if (blockedSaves <= 3 || blockedSaves % 50 === 0) console.error('store: REDIS SAVE BLOCKED —', blocked);
    return false;
  }

  // Detect a second container (old deploy still shutting down, or two
  // replicas) that wrote after us, and merge instead of overwriting.
  const now = Date.now();
  let toWrite = snap;
  if (force || now - lastConflictCheckAt > CONFLICT_CHECK_MS) {
    lastConflictCheckAt = now;
    try {
      const remote = parseSnapshot(await redisCmd(['GET', REDIS_KEY]));
      if (remote) {
        const remoteAt = Number(remote.savedAt) || 0;
        const foreign = remote.savedBy && remote.savedBy !== INSTANCE_ID;
        if (foreign && remoteAt > lastRemoteSavedAt) {
          console.warn('store: another instance wrote at', new Date(remoteAt).toISOString(), '— merging');
          toWrite = mergeSnapshots(remote, snap);
          hydrate(toWrite);                 // adopt the merged state locally
          toWrite = snapshot();
          peakKnownUsers = Math.max(peakKnownUsers, countPlayers(toWrite));
        } else if (!snapshotHasPlayers(snap) && snapshotHasPlayers(remote)) {
          console.warn('store: skip empty overwrite (keeping stored players)');
          return false;
        } else if (countPlayers(snap) < Math.ceil(countPlayers(remote) * SHRINK_GUARD_RATIO) && !force) {
          console.error('store: REDIS SAVE BLOCKED — stored copy has far more players, merging instead');
          toWrite = mergeSnapshots(remote, snap);
          hydrate(toWrite);
          toWrite = snapshot();
          peakKnownUsers = Math.max(peakKnownUsers, countPlayers(toWrite));
        }
      }
    } catch (err) {
      console.warn('store: conflict check failed:', err.message || err);
    }
  }

  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      await redisCmd(['SET', REDIS_KEY, JSON.stringify(toWrite)]);
      lastRemoteSavedAt = Number(toWrite.savedAt) || Date.now();
      lastSaveOkAt = Date.now();
      lastSaveError = null;
      return true;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  lastSaveError = String((lastErr && lastErr.message) || lastErr);
  throw lastErr;
}

async function saveAll(force) {
  const fileOk = saveFile(force);
  if (useRedis) await saveRedis(force);
  else if (fileOk) lastSaveOkAt = Date.now();
  maybeBackup();
}

function saveNow() {
  const fileOk = saveFile(false);
  if (useRedis) {
    saveRedis(false).catch((err) => console.error('store redis save failed:', err.message || err));
  } else if (fileOk) {
    lastSaveOkAt = Date.now();
  }
  maybeBackup();
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 80);
  if (saveTimer.unref) saveTimer.unref();
}

/* ---------------------------- loading ---------------------------- */

function latestBackupFile() {
  try {
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('store-') && f.endsWith('.json')).sort();
    if (!files.length) return null;
    return path.join(BACKUP_DIR, files[files.length - 1]);
  } catch (e) {
    return null;
  }
}

function loadFromDisk() {
  // Self-heal the classic "store.json accidentally became a directory"
  // mistake (see dataFileProblem): rename the directory aside — contents are
  // preserved — so a real file can be created at DATA_FILE again. Without
  // this, the directory lives on inside the volume and EVERY redeploy keeps
  // reverting player data to the last backup. If the path is the volume mount
  // point itself the rename fails and relocateDataFileAside() logs the exact
  // Railway setting that has to change.
  relocateDataFileAside();
  const files = [DATA_FILE];
  if (path.resolve(FALLBACK_FILE) !== path.resolve(DATA_FILE)) files.push(FALLBACK_FILE);
  const backup = latestBackupFile();
  if (backup) files.push(backup);
  for (const filePath of files) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const data = parseSnapshot(fs.readFileSync(filePath, 'utf8'));
      if (!data) continue;
      hydrate(data);
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

async function redisGetWithRetry(key, attempts = 5) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await redisCmd(['GET', key]);
    } catch (err) {
      lastErr = err;
      console.error(`store: redis GET ${key} failed (try ${i + 1}/${attempts}):`, err.message || err);
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr;
}

async function loadLatestRedisBackup() {
  const index = await readBackupIndex();
  for (let i = index.length - 1; i >= 0; i--) {
    try {
      const data = parseSnapshot(await redisCmd(['GET', index[i].key]));
      if (data) {
        hydrate(data);
        console.warn('store: recovered from backup', index[i].key);
        return true;
      }
    } catch (e) {}
  }
  return false;
}

async function loadAll() {
  if (useRedis) {
    try {
      const raw = await redisGetWithRetry(REDIS_KEY);
      const data = parseSnapshot(raw);
      if (data) {
        hydrate(data);
        loadState = 'ok';
        lastRemoteSavedAt = Number(data.savedAt) || 0;
        peakKnownUsers = countPlayers(snapshot());
        console.log(
          'store: loaded',
          allTimeBest.size, 'players,',
          periodBoards.size, 'boards from Upstash Redis'
        );
        return;
      }
      if (raw) {
        // Key exists but is unreadable — try a backup instead of starting empty.
        console.error('store: stored snapshot is corrupted, trying backups');
        if (await loadLatestRedisBackup()) {
          loadState = 'ok';
          peakKnownUsers = countPlayers(snapshot());
          return;
        }
        loadState = 'failed';
        loadError = 'corrupted snapshot and no usable backup';
        console.error('store: DEGRADED MODE — writes are blocked to protect existing data');
        return;
      }
      console.log('store: Redis key empty, trying local file');
    } catch (err) {
      loadError = String(err.message || err);
      console.error('store redis load failed:', loadError);
      if (await loadLatestRedisBackup().catch(() => false)) {
        loadState = 'ok';
        peakKnownUsers = countPlayers(snapshot());
        return;
      }
      loadFromDisk();
      loadState = 'failed';
      console.error(
        'store: DEGRADED MODE — could not reach Redis at startup. The game keeps running,\n' +
        '       but saving is BLOCKED so that nobody\'s balance/leaderboard gets overwritten.\n' +
        '       Fix UPSTASH_REDIS_REST_URL / TOKEN and restart.'
      );
      return;
    }
  }

  const fromFile = loadFromDisk();
  loadState = 'ok';
  peakKnownUsers = countPlayers(snapshot());
  if (!useRedis) {
    console.warn(
      'store: WARNING — no Upstash Redis configured. Data lives in ' + DATA_FILE + ' only.\n' +
      '       On Railway/Render this file is WIPED on every deploy unless it sits on a\n' +
      '       mounted volume. Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN.'
    );
  }
  if (useRedis && fromFile) {
    try {
      await saveRedis(true);
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
  console.log('store: shutting down — flushing data (merge-safe)…');
  // On shutdown always run the conflict check: during a deploy the NEW
  // container may already be serving players, and we must merge with it
  // instead of overwriting its fresh scores with our stale copy.
  const done = (async () => {
    saveFile(false);
    if (useRedis) await saveRedis(true);
  })();
  const timeout = new Promise((r) => setTimeout(r, 8000));
  Promise.race([
    done.catch((err) => console.error('store flush failed:', err.message || err)),
    timeout,
  ]).then(() => process.exit(code));
}
process.on('SIGTERM', () => flushAndExit(0));
process.on('SIGINT', () => flushAndExit(0));

// Periodic safety save + rolling backup, even if the game is idle.
const autosaveTimer = setInterval(() => {
  if (loadState !== 'ok') return;
  saveNow();
}, Math.max(30000, Number(process.env.AUTOSAVE_MS) || 5 * 60 * 1000));
if (autosaveTimer.unref) autosaveTimer.unref();

function createSession(sessionId, userId, seed, extra) {
  extra = extra || {};
  sessions.set(sessionId, {
    userId: String(userId),
    seed,
    startedAt: Date.now(),
    used: false,
    name: extra.name || 'Player',
    token: extra.token || '',
    grantedRevives: Math.max(0, Math.min(2, Number(extra.grantedRevives) || 0)),
    heartbeats: [],
    lastHeartbeatAt: 0,
    lastHeartbeatStep: 0,
  });
}
function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}
/** Atomically mark a session used. Returns the session, or null if missing/already used. */
function consumeSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s || s.used) return null;
  s.used = true;
  return s;
}

function addHeartbeat(sessionId, step) {
  const s = sessions.get(sessionId);
  if (!s || s.used) return { ok: false, error: 'unknown or expired session' };
  step = Math.max(0, Math.floor(Number(step) || 0));
  const now = Date.now();
  if (s.lastHeartbeatAt && now - s.lastHeartbeatAt < 700) {
    return { ok: false, error: 'too fast' };
  }
  if (step < s.lastHeartbeatStep) {
    return { ok: false, error: 'step rewind' };
  }
  const dt = now - (s.lastHeartbeatAt || s.startedAt);
  const maxJump = Math.ceil((dt / 1000) / (1 / 60)) + 120;
  if (step > s.lastHeartbeatStep + maxJump) {
    return { ok: false, error: 'step jump' };
  }
  s.heartbeats.push({ at: now, step });
  if (s.heartbeats.length > 400) s.heartbeats.splice(0, s.heartbeats.length - 400);
  s.lastHeartbeatAt = now;
  s.lastHeartbeatStep = step;
  return { ok: true };
}

function grantRevive(sessionId) {
  const s = sessions.get(sessionId);
  if (!s || s.used) return { ok: false, error: 'unknown or expired session' };
  if (s.grantedRevives >= 2) return { ok: false, error: 'no revives left' };
  s.grantedRevives += 1;
  return { ok: true, grantedRevives: s.grantedRevives };
}

function isBanned(userId) {
  const row = bans.get(String(userId));
  if (!row) return false;
  if (row.until && Date.now() >= row.until) {
    bans.delete(String(userId));
    scheduleSave();
    return false;
  }
  return row.until ? Date.now() < row.until : false;
}

function banInfo(userId) {
  if (!isBanned(userId)) return null;
  return bans.get(String(userId)) || null;
}

function addStrike(userId, reason, details) {
  userId = String(userId);
  const now = Date.now();
  const ev = { userId, reason: String(reason || 'cheat').slice(0, 120), at: now, details: details || null };
  antiCheatEvents.push(ev);
  if (antiCheatEvents.length > 400) antiCheatEvents.splice(0, antiCheatEvents.length - 400);

  const row = bans.get(userId) || { until: 0, reason: '', strikes: 0, windowStart: now };
  if (!row.windowStart || now - row.windowStart > 24 * 60 * 60 * 1000) {
    row.windowStart = now;
    row.strikes = 0;
  }
  row.strikes += 1;
  row.reason = ev.reason;
  // 5 rejects in 24h → 12h ban; 8 → 48h.
  if (row.strikes >= 8) {
    row.until = now + 48 * 60 * 60 * 1000;
  } else if (row.strikes >= 5) {
    row.until = now + 12 * 60 * 60 * 1000;
  }
  bans.set(userId, row);
  scheduleSave();
  return row;
}

function listAntiCheatEvents(limit) {
  return antiCheatEvents.slice(-(limit || 50)).reverse();
}

// --- manual moderation ---------------------------------------------------
function listBans(limit) {
  const now = Date.now();
  const out = [];
  for (const [userId, row] of bans) {
    // Only rows with a set, not-yet-expired until are ACTUAL bans. A user can
    // have strikes recorded (until:0) without being banned yet — they must not
    // appear in the "currently blocked" list.
    if (!row.until || now >= row.until) continue;
    out.push({
      userId,
      until: row.until,
      reason: row.reason || 'cheat',
      strikes: row.strikes || 0,
      minutesLeft: Math.max(0, Math.round((row.until - now) / 60000)),
    });
  }
  out.sort((a, b) => b.until - a.until);
  return out.slice(0, limit || 100);
}

function manualBan(userId, reason, minutes) {
  userId = String(userId);
  const now = Date.now();
  const row = bans.get(userId) || { until: 0, reason: '', strikes: 0, windowStart: now };
  row.strikes = Math.max(row.strikes || 0, 5); // never below the auto-ban threshold
  row.reason = String(reason || 'manual ban').slice(0, 120);
  row.until = now + Math.max(1, Math.floor(Number(minutes) || 60)) * 60 * 1000;
  bans.set(userId, row);
  antiCheatEvents.push({ userId, reason: 'manual ban: ' + row.reason, at: now, details: { until: row.until } });
  if (antiCheatEvents.length > 400) antiCheatEvents.splice(0, antiCheatEvents.length - 400);
  scheduleSave();
  return { userId, until: row.until, reason: row.reason, strikes: row.strikes };
}

function unban(userId) {
  const removed = bans.delete(String(userId));
  if (removed) scheduleSave();
  return removed;
}

setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, s] of sessions) if (s.startedAt < cutoff) sessions.delete(id);
  const actCutoff = Date.now() - 10 * 60 * 1000;
  for (const [uid, ts] of recentActivity) if (ts < actCutoff) recentActivity.delete(uid);
  // Rate-limit buckets live in memory forever otherwise; a long-running
  // process would accumulate an entry per IP / user id it ever saw. Drop
  // buckets whose newest timestamp is older than an hour.
  const bucketCutoff = Date.now() - 60 * 60 * 1000;
  for (const [key, times] of rateBuckets) {
    const fresh = times.filter((t) => t > bucketCutoff);
    if (fresh.length === 0) rateBuckets.delete(key);
    else rateBuckets.set(key, fresh);
  }
}, 10 * 60 * 1000).unref();

function upsertBoardScore(key, userId, name, score) {
  userId = String(userId);
  score = Math.max(0, Math.min(100000, Math.floor(Number(score) || 0)));
  name = String(name || 'Player').replace(/[\u0000-\u001f\u007f<>]/g, '').slice(0, 48) || 'Player';
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
  score = Math.max(0, Math.min(100000, Math.floor(Number(score) || 0)));
  name = String(name || 'Player').replace(/[\u0000-\u001f\u007f<>]/g, '').slice(0, 48) || 'Player';
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
  amount = Number(amount);
  if (!Number.isFinite(amount)) return getBalance(userId);
  const bal = getBalance(userId) + amount;
  balances.set(String(userId), bal);
  scheduleSave();
  return bal;
}
function getCBalance(userId) {
  return cBalances.get(String(userId)) || 0;
}
function creditCBalance(userId, amount) {
  amount = Number(amount);
  if (!Number.isFinite(amount)) return getCBalance(userId);
  const bal = getCBalance(userId) + amount;
  cBalances.set(String(userId), bal);
  scheduleSave();
  return bal;
}

const MIN_WITHDRAW_FLAP = Math.max(1, Math.floor(Number(process.env.MIN_WITHDRAW_FLAP) || 10));

function requestWithdrawal(userId, name, address, amount) {
  userId = String(userId);
  amount = Math.floor(Number(amount));
  const bal = getBalance(userId);
  if (!Number.isFinite(amount) || amount < MIN_WITHDRAW_FLAP) {
    return { ok: false, error: 'minimum withdrawal is ' + MIN_WITHDRAW_FLAP + ' FLAP' };
  }
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
  if (w.status === 'paid') return w;
  w.status = 'paid';
  w.paidAt = Date.now();
  scheduleSave();
  return w;
}

function requestDeposit(userId, name, amount, txHash) {
  userId = String(userId);
  amount = Math.floor(Number(amount));
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'invalid amount' };
  if (amount > 1e9) return { ok: false, error: 'invalid amount' };
  const hash = String(txHash || '').trim().toLowerCase();
  if (hash.length < 8 || hash.length > 128) return { ok: false, error: 'invalid transaction hash' };
  const dup = deposits.find((d) => d && String(d.txHash || '').toLowerCase() === hash && d.status !== 'rejected');
  if (dup) return { ok: false, error: 'transaction already submitted' };
  const request = {
    id: depositSeq++,
    userId,
    name,
    amount,
    txHash: hash,
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
  creditReferralCommissions(d.userId, d.amount);
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

function trackUser(userId, profile) {
  userId = String(userId);
  const now = Date.now();
  const wasNew = !knownUsers.has(userId);
  const previous = userDirectory.get(userId) || {};
  const details = typeof profile === 'string' ? { name: profile } : (profile || {});
  const name = String(details.name || previous.name || 'Player').slice(0, 120);
  const username = String(details.username || previous.username || '').slice(0, 64);
  const firstSeen = Number(previous.firstSeen) || now;
  // Persist identity changes immediately, but do not write the whole store
  // on every page refresh. The in-memory lastSeen is still updated for the
  // admin list; it is persisted at most once per minute per player.
  const changed = wasNew || previous.name !== name || previous.username !== username ||
    !previous.lastSeen || now - previous.lastSeen >= 60 * 1000 || previous.firstSeen !== firstSeen;
  knownUsers.add(userId);
  userDirectory.set(userId, { name, username, firstSeen, lastSeen: now });
  recentActivity.set(userId, now);
  if (changed) scheduleSave();
}
function listUsers(limit) {
  const ids = new Set([
    ...knownUsers,
    ...userDirectory.keys(),
    ...allTimeBest.keys(),
    ...balances.keys(),
    ...cBalances.keys(),
    ...referralByUser.keys(),
  ]);
  const out = [];
  for (const uid of ids) {
    const row = userDirectory.get(String(uid)) || {};
    const best = allTimeBest.get(String(uid));
    const referral = referralByUser.get(String(uid));
    out.push({
      userId: String(uid),
      name: row.name || (best && best.name) || (referral && referral.name) || 'Player',
      username: row.username || '',
      firstSeen: row.firstSeen || 0,
      lastSeen: row.lastSeen || 0,
    });
  }
  out.sort((a, b) => (b.lastSeen || b.firstSeen || 0) - (a.lastSeen || a.firstSeen || 0));
  return out.slice(0, Math.max(1, Math.min(1000, Number(limit) || 200)));
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
    turnStartedAt: match.turn === 'p1' ? (match.p1TurnAt || 0) : (match.turn === 'p2' ? (match.p2TurnAt || 0) : 0),
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
  // Only clear a user's match pointer if it still points at THIS match.
  // A player may have re-joined a newer match since this one finished, and
  // wiping the pointer here would orphan their active match.
  if (match.p1 && pvpByUser.get(String(match.p1.userId)) === match.id) pvpClearUser(match.p1.userId);
  if (match.p2 && pvpByUser.get(String(match.p2.userId)) === match.id) pvpClearUser(match.p2.userId);
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
  if (!match || match.status !== 'confirming' || match.paid) return false;
  const s = match.stake;
  if (getCBalance(match.p1.userId) < s || getCBalance(match.p2.userId) < s) {
    // One (or both) can no longer cover the stake. Drop the match but put the
    // player who still CAN pay back in the queue so they aren't silently removed.
    const p1Short = getCBalance(match.p1.userId) < s;
    const p2Short = getCBalance(match.p2.userId) < s;
    pvpDropMatch(match);
    if (!p1Short) pvpRequeue(match.p1.userId, match.p1.name, s);
    if (!p2Short) pvpRequeue(match.p2.userId, match.p2.name, s);
    scheduleSave();
    return false;
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
  return true;
}

function pvpBeginP1(match) {
  const now = Date.now();
  match.status = 'p1_playing';
  match.turn = 'p1';
  match.p1TurnAt = now;
  match.p1Deadline = now + PVP_TURN_MS;
  match.p1.lastSeen = now;
  match.p2.lastSeen = now;
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

// Background sweeper so PvP matches advance even when no client is polling:
// enforces forfeit/deadline/confirm timeouts and drops finished matches.
setInterval(() => {
  try {
    pvpSweepTimeouts();
  } catch (err) {
    console.error('pvpSweepTimeouts failed:', err.message || err);
  }
}, 3000).unref();

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

  // Drop anyone who has been waiting too long OR can no longer cover the stake,
  // so we never pull an insolvent opponent out of the queue and then fail the join.
  let q = (pvpQueue.get(stake) || []).filter((x) => {
    if (x.userId === userId) return false;
    if (Date.now() - x.joinedAt >= 10 * 60 * 1000) return false;
    return getCBalance(x.userId) >= stake;
  });
  if (q.length) {
    const idx = Math.floor(Math.random() * q.length);
    const opp = q.splice(idx, 1)[0];
    pvpQueue.set(stake, q);
    if (getCBalance(userId) < stake) {
      // Joiner went broke between the earlier check and now — put the opponent back.
      pvpRequeue(opp.userId, opp.name, stake);
      return { ok: false, error: 'insufficient C' };
    }
    if (getCBalance(opp.userId) < stake) {
      // Opponent went broke in the tiny window after the filter. Don't strand the joiner.
      q.push({ userId, name: name || 'Player', joinedAt: Date.now() });
      pvpQueue.set(stake, q);
      return { ok: true, waiting: true, stake, cBalance: getCBalance(userId) };
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
    if (m.status === 'confirming' && !m.paid) {
      pvpAbortConfirm(m, userId);
    } else if (m.paid && m.status !== 'done') {
      // After C is taken, walking away is a forfeit, not a free exit.
      pvpFinishForfeit(m, userId);
      return { ok: true, match: publicPvp(m, userId) };
    }
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
  // Never skip the 5s decline window by calling ready early — that would
  // force-debit the opponent before they can decline.
  if (match.status === 'confirming') return { ok: true, match: publicPvp(match, userId) };
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
    const maybe = code.replace(/^ref[_-]?/i, '');
    // Only credit a referrer who already exists — don't invent ghost accounts
    // from a forged start_param (scripts used to mint fake uplines).
    if (knownUsers.has(String(maybe)) || referralByUser.has(String(maybe))) {
      referrerId = maybe;
    }
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
  if (!(amount > 0)) return [];
  // Level 1 / 2 / 3 of the depositor's upline: 7% / 3% / 1% in C.
  const rates = [0.07, 0.03, 0.01];
  const paid = [];
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
      paid.push({ userId: parentId, level: i + 1, amount: pay });
    }
    uid = parentId;
  }
  if (paid.length) scheduleSave();
  return paid;
}

function pvpSubmitScore(userId, score, opts) {
  userId = String(userId);
  score = Math.max(0, Math.min(100000, Math.floor(Number(score) || 0)));
  pvpSweepTimeouts();
  const id = pvpByUser.get(userId);
  if (!id || !pvpMatches.has(id)) return { ok: false, error: 'no match' };
  const match = pvpMatches.get(id);
  if (match.status === 'done') return { ok: true, match: publicPvp(match, userId) };

  const startedAt = opts && Number.isFinite(opts.sessionStartedAt) ? opts.sessionStartedAt : 0;
  function sessionFreshFor(turnAt) {
    if (!startedAt || !turnAt) return true;
    // Session must have been issued for THIS turn, not an older classic/PvP run.
    return startedAt >= turnAt;
  }

  if (match.status === 'p1_playing' && match.p1.userId === userId && match.p1.score == null) {
    if (!sessionFreshFor(match.p1TurnAt)) return { ok: false, error: 'stale session' };
    match.p1.score = score;
    match.p1.lastSeen = Date.now();
    match.status = 'p2_playing';
    match.turn = 'p2';
    match.p2TurnAt = Date.now();
    match.p2Deadline = match.p2TurnAt + PVP_TURN_MS;
    match.p2.lastSeen = Date.now();
    scheduleSave();
    return { ok: true, match: publicPvp(match, userId) };
  }
  if (match.status === 'p2_playing' && match.p2.userId === userId && match.p2.score == null) {
    if (!sessionFreshFor(match.p2TurnAt)) return { ok: false, error: 'stale session' };
    match.p2.score = score;
    match.p2.lastSeen = Date.now();
    pvpResolve(match);
    return { ok: true, match: publicPvp(match, userId) };
  }
  return { ok: false, error: 'not your turn' };
}

module.exports = {
  currentDayKey, currentWeekKey, currentMonthKey, previousWeekKey, periodKey,
  weekAlreadyPaid,
  createSession, getSession, consumeSession, addHeartbeat, grantRevive,
  isBanned, banInfo, addStrike, listAntiCheatEvents,
  manualBan, unban, listBans,
  submitPeriodScores, submitWeeklyScore, getLeaderboard, getUserRank,
  allowRequest,
  archiveWeek,
  rewardHistory,
  updateAllTimeBest, getAllTimeBest,
  getBalance, creditBalance, getCBalance, creditCBalance,
  requestWithdrawal, listWithdrawals, markWithdrawalPaid, MIN_WITHDRAW_FLAP,
  requestDeposit, listDeposits, approveDeposit, rejectDeposit,
  trackUser, listUsers, getTotalUsers, getActivePlayers, recordRun, getRunStats,
  pvpJoin, pvpCancel, pvpDecline, pvpReady, pvpAck, pvpForfeit, pvpHeartbeat, pvpStatus, pvpSubmitScore, PVP_STAKES,
  attachReferral, getReferralInfo, getReferralLeaderboardDay,
  dataFile: DATA_FILE,
  ready,
  flush: saveNow,
  getSnapshot: snapshot,
  createBackup,
  probeDurability,
  _mergeSnapshots: mergeSnapshots,
  _countPlayers: countPlayers,
  _dataFileMountHint: dataFileMountHint,
  _relocateDataFileAside: relocateDataFileAside,
  listBackups,
  restoreBackup,
  importSnapshot: async function(data) {
    hydrate(data);
    peakKnownUsers = countPlayers(snapshot());
    const fileOk = saveFile(true);
    if (useRedis) {
      try {
        await saveRedis(true);
      } catch (err) {
        if (!fileOk) throw new Error('failed to persist restored snapshot: ' + String((err && err.message) || err));
        console.error('store redis save failed:', err.message || err);
      }
    } else if (!fileOk) {
      // Nothing durable was written (e.g. DATA_FILE is a directory and even
      // the auto-fix could not help) — never report this restore as ok.
      throw new Error('failed to persist restored snapshot: ' + (lastSaveError || 'file write failed'));
    }
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
    const durable = durableLooksOk();
    const problem = dataFileProblem();
    return {
      dataFile: DATA_FILE,
      exists,
      bytes,
      dataFileIsDirectory: !!problem,
      // Only set while DATA_FILE is broken: the copy-pasteable Railway fix, so
      // /internal/health, the admin page and check:durable can all show it.
      dataFileHint: problem ? dataFileMountHint() : null,
      redis: useRedis,
      backend: useRedis ? 'upstash-redis' : 'file',
      players: allTimeBest.size,
      boards: periodBoards.size,
      // data-safety diagnostics
      instanceId: INSTANCE_ID,
      loadState,
      loadError,
      degraded: loadState !== 'ok',
      durable,
      warning: durable ? null : 'Data is stored in an ephemeral file — it will be lost on the next deploy. Configure Upstash Redis or a mounted volume.',
      peakKnownUsers,
      blockedSaves,
      lastSaveOkAt,
      lastSaveError,
      lastBackupAt,
      backupEveryMs: BACKUP_EVERY_MS,
      backupKeep: BACKUP_KEEP,
    };
  },
};
