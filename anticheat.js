/**
 * Server-side anti-cheat for GRM FLAP.
 *
 * The client is untrusted. A modified index.html, a userscript, or a
 * raw HTTP client can send any flapLog / reviveLog / score it wants.
 * Everything that decides a leaderboard score or moves money MUST go
 * through these checks on top of physics.js replay.
 *
 * Layers:
 *   1. Input sanitization (no huge/NaN/object payloads).
 *   2. Session binding (user + HMAC token + one-shot consume).
 *   3. Wall-clock vs simulated time (no instant 10-minute perfect run).
 *   4. Heartbeats with monotonic step (must actually sit in the session).
 *   5. Unearned revives dropped (ads are not S2S-verified).
 *   6. Human tap-cadence analysis (bots flap on a perfect metronome).
 *   7. Score ceiling + strikes / temp-ban for repeat offenders.
 */
'use strict';

const crypto = require('crypto');
const P = require('./physics.js');

// Numeric env reader that honours an explicit 0 (see the note in store.js).
function envNum(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const MAX_FLAP_LOG = 8000;
const MAX_REVIVE_LOG = 4;
// Absolute score ceiling. This used to be a fixed 400, which is far past what
// a finger can produce in this physics: measurements in security/solver-poc.js
// show that adding +-1 simulation step (~17ms) of random timing noise to a
// solved 89-point run drops it to an average of 17, and +-3 steps (~50ms)
// drops it to 3.5. Human motor noise is 30-80ms, so triple-digit scores are a
// machine signature, not a skill signature. Override with SCORE_HARD_CAP.
const MAX_SCORE = Math.max(10, envNum('SCORE_HARD_CAP', 150));
const MAX_NAME_LEN = 48;
const MIN_HEARTBEAT_GAME_MS = 25000;
const HEARTBEAT_MAX_GAP_MS = 45000;
const MIN_FLAP_GAP_STEPS = Math.floor((1 / P.MAX_FLAPS_PER_SECOND) / P.STEP);

// ---- Machine-tap detectors (real-time seed-solver bots) ----------------
// A real-time solver plays out the deterministic run and taps on a very tight
// band of step-gaps. It may sprinkle a few outlier pauses to fake "human
// jitter" and dodge a plain variance check, but over a LONG, HIGH run the
// distribution is still dominated by one or two step-gap values. A human's
// tap-gap distribution is far more spread out. These thresholds are tuned
// high on purpose so a genuine elite human run is not rejected.
const MACHINE_CONCENTRATION_MIN_SCORE = 70; // don't judge short/panic runs
const MACHINE_CONCENTRATION_MIN_GAPS = 60;
const MACHINE_CONCENTRATION_MAX_CV = 0.35;
const MACHINE_CONCENTRATION_TOP2_MIN = 0.85; // top-2 gap values share of all

// ---- Autopilot ("solver bot") detector ---------------------------------
// physics.js is public (/physics.js) and /api/start-session hands out the
// seed, so a script can SOLVE a run instead of guessing at it. Cadence
// heuristics cannot see that: a solver's tap gaps look perfectly irregular
// (measured on a real solver: cv 0.44, 42 distinct gaps over 1200 taps).
//
// What a solver cannot fake is *necessity*. Every tap it emits is load-
// bearing — delete any one of them and the run dies earlier, because the
// sequence is a solution, not a performance. A human's stream is full of
// panic taps and over-corrections that the run would survive without.
// Measured on a solved 453-pipe run: 0 of 80 sampled taps were removable.
//
// So: sample taps, delete each, replay with the same seed, and count how
// many the run survives without. ~0% removable over a long high run is a
// machine. Cost is bounded (24 replays of a 30k-step run measured at 35ms)
// and it only runs for submissions that are already high scoring.
const SOLVER_MIN_SCORE = envNum('SOLVER_MIN_SCORE', 40);
const SOLVER_MIN_FLAPS = envNum('SOLVER_MIN_FLAPS', 60);
const SOLVER_SAMPLES = Math.max(6, Number(process.env.SOLVER_SAMPLES) || 24);
const SOLVER_MAX_REPLAY_STEPS = Math.max(600, envNum('SOLVER_MAX_REPLAY_STEPS', 30000));
const SOLVER_MAX_REMOVABLE_RATIO = envNum('SOLVER_MAX_REMOVABLE_RATIO', 0.05);

// ---- Score realism gate -------------------------------------------------
// Because the game is solvable, "score" alone cannot be trusted even when the
// replay confirms it: a bot reproduces 453 pipes on demand. What a bot cannot
// reproduce is a *history*. A real player climbs slowly from a low best; a
// script posts a near-cap run on an account that has never played before.
const SCORE_GATE = {
  enabled: process.env.SCORE_GATE_ENABLED !== 'false',
  newAccountCap: Math.max(5, envNum('SCORE_NEW_ACCOUNT_CAP', 30)),
  youngAccountCap: Math.max(5, envNum('SCORE_YOUNG_ACCOUNT_CAP', 60)),
  trustedCap: Math.max(5, envNum('SCORE_TRUSTED_CAP', 150)),
  jumpMax: Math.max(2, envNum('SCORE_JUMP_MAX', 12)),
  newAccountRuns: Math.max(1, envNum('SCORE_NEW_ACCOUNT_RUNS', 15)),
  youngAccountRuns: Math.max(2, envNum('SCORE_YOUNG_ACCOUNT_RUNS', 40)),
};

let sessionSecret = Buffer.from(
  process.env.SESSION_SECRET || process.env.BOT_TOKEN || crypto.randomBytes(32).toString('hex'),
  'utf8'
);

function setSessionSecret(secret) {
  sessionSecret = Buffer.from(String(secret || ''), 'utf8');
  if (sessionSecret.length < 8) sessionSecret = crypto.randomBytes(32);
}

function hmacHex(data) {
  return crypto.createHmac('sha256', sessionSecret).update(String(data)).digest('hex');
}

function sessionToken(sessionId, userId, seed) {
  return hmacHex(['v1', sessionId, userId, seed].join('|')).slice(0, 40);
}

function tokensMatch(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (!x || !y || x.length !== y.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(x, 'utf8'), Buffer.from(y, 'utf8'));
  } catch (e) {
    return false;
  }
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (!ba.length || ba.length !== bb.length) {
    const dummy = Buffer.alloc(32);
    crypto.timingSafeEqual(dummy, dummy);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function sanitizeIntArray(input, maxLen, maxVal) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const cap = Math.min(input.length, maxLen);
  const limit = Number.isFinite(maxVal) ? maxVal : P.MAX_STEPS_PER_SESSION;
  let prev = -1;
  for (let i = 0; i < cap; i++) {
    const n = input[i];
    if (typeof n !== 'number' || !Number.isFinite(n)) continue;
    const v = n | 0;
    if (v < 0 || v > limit) continue;
    if (v <= prev) continue; // strictly increasing — drops dupes / rewinds
    out.push(v);
    prev = v;
  }
  return out;
}

function sanitizeName(raw) {
  let s = String(raw || 'Player');
  s = s.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  if (!s) s = 'Player';
  if (s.length > MAX_NAME_LEN) s = s.slice(0, MAX_NAME_LEN);
  return s;
}

function sanitizeTxHash(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!/^[a-z0-9:_-]{8,128}$/.test(s)) return '';
  return s;
}

function clientIp(req) {
  // Prefer Express's req.ip: with `app.set('trust proxy', 1)` it walks
  // X-Forwarded-For from the SOCKET side and returns the address the
  // trusted proxy itself appended — the value a client cannot forge.
  // Taking the raw left-most XFF entry (as before) let a script rotate a
  // spoofed header and reset the per-IP rate limit on every request.
  if (req && typeof req.ip === 'string' && req.ip) return req.ip;
  const xf = req && req.headers && req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) {
    const parts = xf.split(',').map((s) => s.trim()).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last && last.length < 80) return last;
  }
  return (req && req.socket && req.socket.remoteAddress) || 'unknown';
}

/**
 * Bots that drive physics.js locally tend to flap on the exact minimum
 * legal interval (or on a perfectly constant interval) for the whole run.
 * Humans have jitter. Short / low-score runs are not judged — too easy
 * to false-positive a panicked mash.
 */
function analyzeFlapPattern(flapLog, score) {
  if (!flapLog || flapLog.length < 28 || score < 28) {
    return { ok: true, regularity: 0, atMinRatio: 0 };
  }
  const gaps = [];
  for (let i = 1; i < flapLog.length; i++) gaps.push(flapLog[i] - flapLog[i - 1]);
  const atMin = gaps.filter((g) => g === MIN_FLAP_GAP_STEPS).length;
  const atMinRatio = atMin / gaps.length;
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  let varSum = 0;
  for (let i = 0; i < gaps.length; i++) {
    const d = gaps[i] - mean;
    varSum += d * d;
  }
  const stdev = Math.sqrt(varSum / gaps.length);
  // Coefficient of variation is scale-free, so a metronome on a LONGER
  // constant interval (e.g. gap 18-19 steps instead of the legal minimum)
  // still trips it — stdev alone missed a ±1-step jittered solver.
  const cv = mean > 0 ? stdev / mean : 0;
  const uniqueGaps = new Set(gaps).size;

  // Fraction of all inter-flap gaps that fall in the two most frequent values.
  // Close to 1 = the stream is dominated by a couple of intervals = a script
  // (or a seed-solver) tapping on a rhythm, even if it throws in rare jitter.
  function top2GapFraction() {
    const freq = new Map();
    for (const g of gaps) freq.set(g, (freq.get(g) || 0) + 1);
    const counts = Array.from(freq.values()).sort((a, b) => b - a);
    const top2 = (counts[0] || 0) + (counts[1] || 0);
    return top2 / gaps.length;
  }

  if (score >= MACHINE_CONCENTRATION_MIN_SCORE &&
      gaps.length >= MACHINE_CONCENTRATION_MIN_GAPS &&
      cv <= MACHINE_CONCENTRATION_MAX_CV &&
      top2GapFraction() >= MACHINE_CONCENTRATION_TOP2_MIN) {
    const top2f = top2GapFraction();
    return { ok: false, reason: 'machine-like tap concentration', atMinRatio, stdev, cv, uniqueGaps, top2f };
  }

  if (score >= 40 && atMinRatio > 0.88) {
    return { ok: false, reason: 'inhuman tap cadence', atMinRatio, stdev, cv, uniqueGaps };
  }
  if (score >= 40 && stdev < 0.45 && gaps.length > 40) {
    return { ok: false, reason: 'inhuman tap regularity', atMinRatio, stdev, cv, uniqueGaps };
  }
  // Almost perfectly regular timing at ANY interval: a jittered solver bot
  // (e.g. flaps every 18-19 steps, stdev ~0.8 but only ~3 distinct gaps) is
  // just as non-human as the minimum-gap metronome. Humans flick with
  // jitter that grows with the length of the run.
  if (score >= 60 && gaps.length > 60 && cv < 0.1 && uniqueGaps <= 4) {
    return { ok: false, reason: 'machine-regular taps', atMinRatio, stdev, cv, uniqueGaps };
  }
  // Very few distinct inter-flap intervals over a long, high run = the
  // tap stream came out of a script, not fingers.
  if (score >= 80 && uniqueGaps <= 3 && gaps.length > 50) {
    return { ok: false, reason: 'metronome bot', atMinRatio, stdev, cv, uniqueGaps };
  }
  return { ok: true, atMinRatio, stdev, cv, uniqueGaps };
}

function checkHeartbeats(heartbeats, startedAt, elapsedMs, totalSteps) {
  const beats = Array.isArray(heartbeats) ? heartbeats : [];
  const simMs = totalSteps * (P.STEP * 1000);
  // Judge against simulated play time, NOT wall-clock since session start —
  // the player may sit on the game-over card for a while before submitting.
  if (simMs < MIN_HEARTBEAT_GAME_MS) return { ok: true, beatCount: beats.length };

  if (beats.length === 0) {
    return { ok: false, reason: 'missing live heartbeats', beatCount: 0 };
  }

  let lastAt = startedAt;
  let lastStep = 0;
  for (let i = 0; i < beats.length; i++) {
    const b = beats[i];
    const at = Number(b && b.at) || 0;
    const step = Number(b && b.step) | 0;
    if (at < lastAt - 50) return { ok: false, reason: 'heartbeat clock rewind', beatCount: beats.length };
    if (step < lastStep) return { ok: false, reason: 'heartbeat step rewind', beatCount: beats.length };
    lastAt = Math.max(lastAt, at);
    lastStep = step;
  }

  const last = beats[beats.length - 1];
  const runEndAt = startedAt + simMs;
  if (runEndAt - (Number(last.at) || 0) > HEARTBEAT_MAX_GAP_MS) {
    return { ok: false, reason: 'heartbeat stale', beatCount: beats.length };
  }

  const expectedMin = Math.max(1, Math.floor(simMs / HEARTBEAT_MAX_GAP_MS));
  if (beats.length < expectedMin) {
    return { ok: false, reason: 'too few heartbeats', beatCount: beats.length, expectedMin };
  }

  // Last reported step must reach the END of the run. A legit client pings
  // every ~3s while playing, so the final beat is within a few hundred
  // steps of the crash. A script that idles (low-step pings to satisfy the
  // "must have heartbeats" rule) and then dumps a precomputed 3-minute
  // perfect flapLog fails this. Require either the loose fraction (short
  // runs, where one missed beat matters) OR being within 8s (~480 steps)
  // of the final step (long runs, where this is airtight).
  const lastStepReported = Number(last.step) | 0;
  if (totalSteps > 180) {
    const required = Math.max(Math.floor(totalSteps * 0.45), totalSteps - 480);
    if (lastStepReported < required) {
      return { ok: false, reason: 'heartbeat steps do not match run', beatCount: beats.length, lastStepReported, required };
    }
  }
  return { ok: true, beatCount: beats.length };
}

function checkTiming(totalSteps, elapsedMs, reviveAllowanceMs) {
  const claimedMs = totalSteps * (P.STEP * 1000);
  const TOLERANCE = 1.12;
  const budget = (elapsedMs + (reviveAllowanceMs || 0)) * TOLERANCE + 1800;
  if (claimedMs > budget) {
    return { ok: false, reason: 'implausible timing', claimedMs, elapsedMs };
  }
  return { ok: true, claimedMs, elapsedMs };
}

function allowedStepsFor(elapsedMs, reviveAllowanceMs) {
  const seconds = ((elapsedMs + (reviveAllowanceMs || 0)) / 1000);
  return Math.min(
    P.MAX_STEPS_PER_SESSION,
    Math.ceil(seconds / P.STEP) + 5
  );
}

/**
 * Is every tap load-bearing? Sample taps, delete each one, replay from the
 * same seed and see whether the run still reaches the same score.
 *
 * @returns {{ok:boolean, sampled:number, removable:number, ratio:number, score:number}}
 *          ok:false means the stream looks machine-generated.
 */
function flapRedundancy(seed, flapLog, totalSteps) {
  const idle = { ok: true, sampled: 0, removable: 0, ratio: 0, score: 0, skipped: true };
  if (!Number.isFinite(seed) || !Array.isArray(flapLog) || flapLog.length < SOLVER_MIN_FLAPS) return idle;

  const steps = Math.min(Math.max(0, totalSteps | 0), SOLVER_MAX_REPLAY_STEPS);
  if (steps <= 0) return idle;
  // Only taps inside the replayed window can possibly matter. Sampling taps
  // that come after the run ended would count them all as "removable" and let
  // a bot pad the log with dead taps to fake a human panic-rate.
  const active = flapLog.filter((f) => (f | 0) >= 0 && (f | 0) < steps);
  if (active.length < SOLVER_MIN_FLAPS) return idle;
  const base = P.simulate(seed, active, steps, []);
  if (base.score < SOLVER_MIN_SCORE) return Object.assign(idle, { skipped: false, score: base.score });

  // Deterministic, evenly spread sample — no RNG, so the verdict for a given
  // submission never changes between two servers or two retries.
  const n = Math.min(SOLVER_SAMPLES, active.length);
  let removable = 0;
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(((i + 0.5) * active.length) / n);
    const without = active.slice();
    without.splice(idx, 1);
    if (P.simulate(seed, without, steps, []).score >= base.score) removable++;
  }
  const ratio = removable / n;
  return {
    ok: ratio > SOLVER_MAX_REMOVABLE_RATIO,
    sampled: n,
    removable,
    ratio,
    score: base.score,
    skipped: false,
  };
}

/**
 * How much of the run survives +-1 step (~17ms) of timing noise. A run that
 * collapses is being played at a precision no finger has. Recorded for
 * review only — see the note in verdict().
 */
function timingRigidity(seed, flapLog, totalSteps, expectedScore) {
  const idle = { ok: true, skipped: true, kept: 1 };
  if (!Number.isFinite(seed) || !Array.isArray(flapLog) || !flapLog.length) return idle;
  const steps = Math.min(Math.max(0, totalSteps | 0), SOLVER_MAX_REPLAY_STEPS);
  if (steps <= 0 || !(expectedScore > 0)) return idle;
  const trials = Math.max(2, Math.min(8, envNum('RIGIDITY_TRIALS', 4)));
  let keptSum = 0;
  for (let t = 1; t <= trials; t++) {
    // Deterministic alternating +-1 shift, so every server reaches the same
    // verdict for the same submission.
    const shifted = flapLog.map((f, i) => ((f | 0) + ((i + t) % 2 ? 1 : -1)));
    const r = P.simulate(seed, shifted, steps, []);
    keptSum += Math.min(1, r.score / expectedScore);
  }
  const kept = keptSum / trials;
  return {
    ok: kept > (envNum('RIGIDITY_MIN_KEPT', 0.35)),
    skipped: false,
    kept: Number(kept.toFixed(3)),
    trials,
  };
}

/**
 * Highest score this account may legitimately post right now. Grows with the
 * number of verified runs, and never more than `jumpMax` above the account's
 * own previous best — so a fresh account cannot open with a near-cap run.
 */
function scoreCeilingFor(profile) {
  const p = profile || {};
  const runs = Math.max(0, Number(p.verifiedRuns) || 0);
  let cap;
  if (runs < SCORE_GATE.newAccountRuns) cap = SCORE_GATE.newAccountCap;
  else if (runs < SCORE_GATE.youngAccountRuns) cap = SCORE_GATE.youngAccountCap;
  else cap = SCORE_GATE.trustedCap;
  const prevBest = Math.max(0, Number(p.best) || 0);
  return Math.min(cap, Math.max(SCORE_GATE.newAccountCap, prevBest + SCORE_GATE.jumpMax));
}

/**
 * Full verdict for a replayed run. `hard` rejects are dropped (no score
 * written). `soft` reasons are recorded as strikes but the score stands.
 */
function verdict(opts) {
  const score = Math.max(0, Math.floor(Number(opts.score) || 0));
  const totalSteps = Math.max(0, Math.floor(Number(opts.totalSteps) || 0));
  const flapLog = opts.flapLog || [];
  const elapsedMs = Math.max(0, Number(opts.elapsedMs) || 0);
  const hard = [];
  const soft = [];

  if (score > MAX_SCORE) hard.push('score above hard cap');
  if (totalSteps > P.MAX_STEPS_PER_SESSION) hard.push('too many steps');
  if (flapLog.length > MAX_FLAP_LOG) hard.push('flap log too large');

  const timing = checkTiming(totalSteps, elapsedMs, opts.reviveAllowanceMs || 0);
  if (!timing.ok) hard.push(timing.reason);

  const hb = checkHeartbeats(opts.heartbeats, opts.startedAt, elapsedMs, totalSteps);
  if (!hb.ok) hard.push(hb.reason);

  const taps = analyzeFlapPattern(flapLog, score);
  if (!taps.ok) hard.push(taps.reason);

  if (opts.revivesUsed > 0 && !(opts.grantedRevives > 0)) {
    hard.push('unearned revive');
  }

  // --- machine-play telemetry (needs the session seed) --------------------
  // MEASURED, NOT ENFORCED. Both of these separate "the run was played with
  // machine precision" from "it was played loosely", but they do NOT separate
  // a bot from a skilled player: security/solver-poc.js shows a plain
  // bang-bang controller also ends up with 0 removable taps and 0 survival
  // under +-1 step noise. Auto-banning on them would ban real players, so they
  // are recorded for review (see /internal/suspects) and never reject a run
  // on their own. The enforceable control is the score ceiling above.
  let redundancy = { ok: true, sampled: 0, skipped: true };
  let rigidity = { skipped: true };
  if (opts.seed != null && Number.isFinite(Number(opts.seed)) && score >= SOLVER_MIN_SCORE) {
    redundancy = flapRedundancy(Number(opts.seed), flapLog, totalSteps);
    rigidity = timingRigidity(Number(opts.seed), flapLog, totalSteps, score);
    if (!redundancy.ok || !rigidity.ok) soft.push('machine-precision play');
  }

  // --- score realism (needs the account's verified-run history) -----------
  let ceiling = null;
  if (opts.account && SCORE_GATE.enabled) {
    ceiling = scoreCeilingFor(opts.account);
    if (score > ceiling) hard.push('score implausible for this account');
  }

  if (score >= 120) soft.push('very high score');

  return {
    ok: hard.length === 0,
    hard,
    soft,
    score,
    taps,
    hb,
    timing,
    redundancy,
    rigidity,
    ceiling,
  };
}

// ---- TOTP (RFC 6238) — optional second factor for the admin area --------
// The admin key is a single bearer secret sent in a header and kept in the
// browser's localStorage. If it leaks, everything under /internal is open,
// including full-store restore. When ADMIN_TOTP_SECRET is set, a 6-digit
// code from any standard authenticator app is required on top of the key.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(input) {
  const s = String(input || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of s) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

function totpCode(secret, atMs, periodSec, digits) {
  periodSec = periodSec || 30;
  digits = digits || 6;
  const counter = Math.floor((atMs == null ? Date.now() : atMs) / 1000 / periodSec);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 4294967296), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const key = base32Decode(secret);
  if (!key.length) return '';
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const off = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[off] & 0x7f) << 24) | (hmac[off + 1] << 16) | (hmac[off + 2] << 8) | hmac[off + 3];
  return String(bin % Math.pow(10, digits)).padStart(digits, '0');
}

function totpValid(secret, code, windowSteps) {
  const s = String(secret || '');
  const c = String(code || '').trim();
  if (!s || !/^[0-9]{6}$/.test(c)) return false;
  const w = Math.max(0, Number.isFinite(windowSteps) ? windowSteps : 1);
  const now = Date.now();
  for (let i = -w; i <= w; i++) {
    const expect = totpCode(s, now + i * 30 * 1000);
    if (expect && safeEqual(expect, c)) return true;
  }
  return false;
}

module.exports = {
  MAX_FLAP_LOG,
  MAX_REVIVE_LOG,
  MAX_SCORE,
  MIN_FLAP_GAP_STEPS,
  SOLVER_MIN_SCORE,
  SOLVER_MIN_FLAPS,
  SOLVER_SAMPLES,
  SOLVER_MAX_REMOVABLE_RATIO,
  SCORE_GATE,
  setSessionSecret,
  sessionToken,
  tokensMatch,
  safeEqual,
  sanitizeIntArray,
  sanitizeName,
  sanitizeTxHash,
  clientIp,
  analyzeFlapPattern,
  checkHeartbeats,
  checkTiming,
  allowedStepsFor,
  flapRedundancy,
  timingRigidity,
  scoreCeilingFor,
  totpCode,
  totpValid,
  base32Decode,
  verdict,
};
