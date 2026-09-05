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

// Small, stable pool of neutral looking nicknames.
const BOT_NAMES = [
  'Nika', 'Arman', 'Sofi', 'Levon', 'Mika', 'Dato', 'Aram', 'Lilit',
  'Roman', 'Karen', 'Zara', 'Tigran', 'Anush', 'Vahe', 'Milena',
  'Suren', 'Gor', 'Ani', 'Davit', 'Elen', 'Hayk', 'Nare', 'Sergo',
  'Vika', 'Artur', 'Lusine', 'Narek', 'Emma', 'Gevorg', 'Sona',
  'Alik', 'Rita', 'Samvel', 'Kristi', 'Ruben', 'Mane', 'Tato',
  'Diana', 'Grigor', 'Alina',
];

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
  const names = BOT_NAMES.slice();
  // Fisher-Yates with the seeded PRNG so the picked names differ per day.
  for (let i = names.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = names[i]; names[i] = names[j]; names[j] = tmp;
  }
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
