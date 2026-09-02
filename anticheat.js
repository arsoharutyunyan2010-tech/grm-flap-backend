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

const MAX_FLAP_LOG = 8000;
const MAX_REVIVE_LOG = 4;
const MAX_SCORE = 400;
const MAX_NAME_LEN = 48;
const MIN_HEARTBEAT_GAME_MS = 25000;
const HEARTBEAT_MAX_GAP_MS = 45000;
const MIN_FLAP_GAP_STEPS = Math.floor((1 / P.MAX_FLAPS_PER_SECOND) / P.STEP);

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
  const xf = req && req.headers && req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) {
    const first = xf.split(',')[0].trim();
    if (first && first.length < 80) return first;
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
  const uniqueGaps = new Set(gaps).size;

  if (score >= 40 && atMinRatio > 0.88) {
    return { ok: false, reason: 'inhuman tap cadence', atMinRatio, stdev, uniqueGaps };
  }
  if (score >= 40 && stdev < 0.45 && gaps.length > 40) {
    return { ok: false, reason: 'inhuman tap regularity', atMinRatio, stdev, uniqueGaps };
  }
  if (score >= 80 && uniqueGaps <= 2 && gaps.length > 50) {
    return { ok: false, reason: 'metronome bot', atMinRatio, stdev, uniqueGaps };
  }
  return { ok: true, atMinRatio, stdev, uniqueGaps };
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

  // Last reported step must be in the same ballpark as the submitted run.
  // A script that idles (step=0 pings) then dumps a precomputed 10-minute
  // flapLog will fail this.
  const lastStepReported = Number(last.step) | 0;
  if (totalSteps > 180 && lastStepReported < totalSteps * 0.45) {
    return { ok: false, reason: 'heartbeat steps do not match run', beatCount: beats.length };
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

  if (score >= 120) soft.push('very high score');

  return {
    ok: hard.length === 0,
    hard,
    soft,
    score,
    taps,
    hb,
    timing,
  };
}

module.exports = {
  MAX_FLAP_LOG,
  MAX_REVIVE_LOG,
  MAX_SCORE,
  MIN_FLAP_GAP_STEPS,
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
  verdict,
};
