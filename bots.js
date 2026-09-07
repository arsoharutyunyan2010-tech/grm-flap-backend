/**
 * Filler bots for the DAILY score leaderboard.
 *
 * The daily board is padded with up to 25 bot entries that all have very low
 * records. They are deterministic for a given day key (same names / scores for
 * every request and every server instance), and they are never persisted.
 *
 * As soon as real players show up on the daily board, the bots with the LOWEST
 * records are dropped one by one — so with 25 real players no bot is left.
 * When the day rolls over (a new day key), the whole bot set is regenerated and
 * they appear again.
 */

const BOT_COUNT = 25;

// Filler bots look like ordinary Telegram accounts: an "@" handle built from a
// stem plus an optional suffix / digits. Most of them are international; only
// ARMENIAN_PER_DAY of them use an Armenian stem, so the board does not read as
// a list of local names.
const ARMENIAN_PER_DAY = 2;

const INTL_STEMS = [
  'alex', 'max', 'nikita', 'dima', 'sasha', 'vlad', 'denis', 'egor', 'kirill',
  'ivan', 'artem', 'roma', 'sergey', 'pavel', 'yura', 'timur', 'murat', 'emir',
  'arda', 'ahmet', 'mehmet', 'ali', 'omar', 'karim', 'luis', 'pedro', 'diego',
  'marco', 'leo', 'nick', 'tony', 'oscar', 'viktor', 'jason', 'kevin', 'brian',
  'anna', 'maria', 'sofia', 'elina', 'katya', 'lena', 'nina', 'julia', 'polina',
  'dasha', 'alina', 'kris', 'mia', 'ela',
  'crypto', 'night', 'shadow', 'ghost', 'turbo', 'pixel', 'lucky', 'sniper',
  'blaze', 'frost', 'nova', 'zero', 'wolf', 'falcon', 'panda', 'rocket',
];

const ARMENIAN_STEMS = [
  'armen', 'hayk', 'narek', 'gevorg', 'tigran', 'vahe', 'arsen', 'samvel',
  'karen', 'mher', 'davo', 'grish', 'ani', 'lilit', 'sona', 'nare', 'anush',
  'hovo', 'gor', 'tato',
];

const SUFFIXES = [
  '', '', '', '_pro', '_off', '_ton', '_tg', '_xx', 'ka', 'chik', '_king',
  '_yt', 'ttv', '_life', '_007', 'x',
];

// Build one plausible Telegram handle from a stem.
function makeHandle(stem, rnd) {
  let name = stem;
  const shape = Math.floor(rnd() * 5);
  if (shape === 0) {
    name += SUFFIXES[Math.floor(rnd() * SUFFIXES.length)];
  } else if (shape === 1) {
    name += String(10 + Math.floor(rnd() * 89));            // ...42
  } else if (shape === 2) {
    name += '_' + String(1990 + Math.floor(rnd() * 22));    // ..._2004
  } else if (shape === 3) {
    name += SUFFIXES[Math.floor(rnd() * SUFFIXES.length)] + String(Math.floor(rnd() * 999));
  } else {
    name += '_' + String(100 + Math.floor(rnd() * 899));    // ..._777
  }
  name = name.replace(/[^a-z0-9_]/g, '').slice(0, 24);
  if (name.length < 5) name += String(10 + Math.floor(rnd() * 89));
  return '@' + name;
}

// Deterministic handle list for a day: ARMENIAN_PER_DAY Armenian stems mixed
// into international ones, shuffled, all unique.
function handlesForDay(rnd, count) {
  const pick = (pool, n) => {
    const copy = pool.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const tmp = copy[i]; copy[i] = copy[j]; copy[j] = tmp;
    }
    return copy.slice(0, n);
  };
  const armCount = Math.min(ARMENIAN_PER_DAY, count);
  const stems = pick(ARMENIAN_STEMS, armCount).concat(pick(INTL_STEMS, count - armCount));
  // shuffle so the Armenian handles do not always sit at the top
  for (let i = stems.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = stems[i]; stems[i] = stems[j]; stems[j] = tmp;
  }
  const seen = new Set();
  const out = [];
  for (const stem of stems) {
    let handle = makeHandle(stem, rnd);
    let guard = 0;
    while (seen.has(handle) && guard++ < 8) handle = makeHandle(stem, rnd);
    seen.add(handle);
    out.push(handle);
  }
  return out;
}

// Deterministic 32-bit hash -> PRNG (mulberry32).
function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build the full bot list for a day key, sorted by score descending.
 * Scores are intentionally tiny (1..25) so any real run outranks them.
 */
function botsForDay(dayKey) {
  const rnd = mulberry32(hashString('flap-bots:' + String(dayKey)));
  const names = handlesForDay(rnd, BOT_COUNT);
  const used = new Set();
  const out = [];
  for (let i = 0; i < BOT_COUNT; i++) {
    let score = 1 + Math.floor(rnd() * 25);
    while (used.has(score)) score = 1 + ((score) % 25) + 0; // keep them distinct
    used.add(score);
    out.push({
      userId: 'bot:' + dayKey + ':' + i,
      name: names[i % names.length],
      score,
      isBot: true,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * Merge bots into a real (already sorted desc) daily entry list.
 * Keeps at most BOT_COUNT rows of bots minus the number of real players,
 * dropping the lowest-scoring bots first.
 */
function padDailyBoard(realEntries, dayKey) {
  const real = Array.isArray(realEntries) ? realEntries : [];
  const slots = Math.max(0, BOT_COUNT - real.length);
  if (slots === 0) return real.slice();
  const bots = botsForDay(dayKey).slice(0, slots);
  const merged = real.concat(bots);
  merged.sort((a, b) => (b.score - a.score) || (a.isBot === b.isBot ? 0 : (a.isBot ? 1 : -1)));
  return merged;
}

module.exports = { BOT_COUNT, botsForDay, padDailyBoard };
