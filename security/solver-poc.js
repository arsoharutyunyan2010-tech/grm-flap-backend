/**
 * security/solver-poc.js — ADVERSARIAL harness (offensive tooling, dev only).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The whole scoring model rests on one claim: "the client can only tell us
 * WHEN it flapped, so a script cannot inflate a score." That is true for the
 * naive `POST {score: 999999}` attack. It is NOT automatically true for a
 * script that plays the game *properly* in real time: `physics.js` is served
 * publicly at `/physics.js`, `/api/start-session` hands the client the seed,
 * and the simulation is 100% deterministic. A script can therefore load
 * physics.js, take the seed, and SOLVE the run.
 *
 * This file is that script. It exists so the anti-cheat can be measured
 * against a real attacker instead of against a guess.
 *
 *   node security/solver-poc.js            # solve + judge with the live detectors
 *   node security/solver-poc.js --quiet
 *
 * It NEVER touches the network or the store: it only uses physics.js (public)
 * and anticheat.js (the server's own judge), so it reproduces exactly the
 * verdict the server would return for a submitted flapLog.
 */
'use strict';

const P = require('../physics.js');
const AC = require('../anticheat.js');

const STEP = P.STEP;
const GRAVITY = P.GRAVITY;
const FLAP_VELOCITY = P.FLAP_VELOCITY;
const MAX_FALL_SPEED = P.MAX_FALL_SPEED;
const LOGICAL_W = P.LOGICAL_W;
const LOGICAL_H = P.LOGICAL_H;
const GROUND_H = P.GROUND_HEIGHT;
const PIPE_W = P.PIPE_WIDTH;
const BIRD_X = P.BIRD_X;
const BIRD_R = P.COIN_RADIUS;
const BIRD_START_Y = P.BIRD_START_Y;
const PIPE_MARGIN = P.PIPE_MARGIN;
const PIPE_INTERVAL = Math.round(1.1 / STEP);
const MIN_GAP_STEPS = AC.MIN_FLAP_GAP_STEPS;
const GROUND_Y = LOGICAL_H - GROUND_H;
const PLAY_H = LOGICAL_H - GROUND_H;

// ---- clonable mulberry32 (same stream as physics.js) --------------------
function rngNext(s) {
  s.a = (s.a + 0x6D2B79F5) | 0;
  let t = Math.imul(s.a ^ (s.a >>> 15), 1 | s.a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return { v: ((t ^ (t >>> 14)) >>> 0) / 4294967296, a: s.a };
}

function hitRect(cx, cy, cr, rx, ry, rw, rh) {
  const closestX = Math.max(rx, Math.min(cx, rx + rw));
  const closestY = Math.max(ry, Math.min(cy, ry + rh));
  const dx = cx - closestX;
  const dy = cy - closestY;
  return (dx * dx + dy * dy) < (cr * cr);
}

/** One physics.js step, mutated in place. Returns true when the bird crashed. */
function stepState(st, flap) {
  if (flap) st.vy = FLAP_VELOCITY;
  st.vy += GRAVITY * STEP;
  if (st.vy > MAX_FALL_SPEED) st.vy = MAX_FALL_SPEED;
  st.y += st.vy * STEP;

  st.pipeTimer++;
  if (st.pipeTimer >= PIPE_INTERVAL) {
    st.pipeTimer = 0;
    const gap = P.currentGap(st.score);
    // Call the REAL physics.js pipe generator through a clonable rng shim, so
    // the layout is bit-identical to what the server replays.
    const rngFn = () => { const r = rngNext(st.rng); st.rng.a = r.a; return r.v; };
    const top = P.nextPipeTop(rngFn, st.lastPipeTop, gap, PLAY_H, PIPE_MARGIN);
    st.lastPipeTop = top;
    st.pipes.push({ x: LOGICAL_W + PIPE_W, top, gap, passed: false });
  }

  const speed = P.currentSpeed(st.score);
  let crashed = st.y + BIRD_R >= GROUND_Y;
  if (st.y - BIRD_R <= 0) { st.y = BIRD_R; st.vy = 0; }

  for (let i = st.pipes.length - 1; i >= 0; i--) {
    const pipe = st.pipes[i];
    pipe.x -= speed * STEP;
    if (!pipe.passed && pipe.x + PIPE_W < BIRD_X - BIRD_R) { pipe.passed = true; st.score++; }
    if (pipe.x < -PIPE_W - 10) { st.pipes.splice(i, 1); continue; }
    if (!crashed && BIRD_X + BIRD_R > pipe.x && BIRD_X - BIRD_R < pipe.x + PIPE_W) {
      const bottomY = pipe.top + pipe.gap;
      if (hitRect(BIRD_X, st.y, BIRD_R * 0.85, pipe.x, 0, PIPE_W, pipe.top)) crashed = true;
      if (hitRect(BIRD_X, st.y, BIRD_R * 0.85, pipe.x, bottomY, PIPE_W, GROUND_Y - bottomY)) crashed = true;
    }
  }
  st.step++;
  return crashed;
}

function freshState(seed) {
  return {
    step: 0, y: BIRD_START_Y, vy: FLAP_VELOCITY * 0.7,
    pipes: [], score: 0, pipeTimer: 0, lastPipeTop: null,
    rng: { a: seed >>> 0 }, lastFlap: -Infinity, flaps: [],
  };
}
function cloneState(st) {
  return {
    step: st.step, y: st.y, vy: st.vy, score: st.score, pipeTimer: st.pipeTimer,
    lastPipeTop: st.lastPipeTop, rng: { a: st.rng.a }, lastFlap: st.lastFlap,
    pipes: st.pipes.map((p) => ({ x: p.x, top: p.top, gap: p.gap, passed: p.passed })),
    flaps: st.flaps, // shared until a flap is appended (copy-on-write below)
  };
}

function centreOfNext(st) {
  for (const p of st.pipes) {
    if (!p.passed) return p.top + p.gap / 2;
  }
  return BIRD_START_Y;
}

/**
 * Beam search over "flap / don't flap" at every step, using the real physics.
 * Deterministic → the same seed always yields the same solved run, which is
 * exactly what a cheat script gets from `/api/start-session`.
 */
function solve(seed, opts) {
  opts = opts || {};
  const beamWidth = opts.beam || 260;
  const maxSteps = Math.min(opts.maxSteps || Number(process.env.POC_STEPS) || 30000, P.MAX_STEPS_PER_SESSION);
  let beam = [freshState(seed)];
  let best = beam[0];

  while (beam.length) {
    const next = [];
    for (const st of beam) {
      if (st.step >= maxSteps) continue;
      const canFlap = (st.step - st.lastFlap) >= MIN_GAP_STEPS;
      const branches = canFlap ? [false, true] : [false];
      for (const flap of branches) {
        const child = cloneState(st);
        const crashed = stepState(child, flap);
        if (crashed) continue;
        if (flap) { child.flaps = st.flaps.concat(child.step - 1); child.lastFlap = child.step - 1; }
        if (child.score > best.score || (child.score === best.score && child.step > best.step)) best = child;
        next.push(child);
      }
    }
    if (!next.length) break;
    // Dedupe near-identical states so the beam keeps genuinely different lines
    // alive instead of N copies of one trajectory that all die together.
    const seen = new Map();
    for (const st of next) {
      const key = st.score + ':' + Math.round(st.y / 5) + ':' + Math.round(st.vy / 60);
      const prev = seen.get(key);
      if (!prev || Math.abs(st.y - centreOfNext(st)) < Math.abs(prev.y - centreOfNext(prev))) seen.set(key, st);
    }
    const pool = Array.from(seen.values());
    pool.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const ca = Math.abs(a.y - centreOfNext(a));
      const cb = Math.abs(b.y - centreOfNext(b));
      return ca - cb;
    });
    beam = pool.slice(0, beamWidth);
  }
  return { seed, flaps: best.flaps.slice(), score: best.score, steps: best.step };
}

/**
 * Turn a solved flapLog into the "human" tap stream a cheat author would
 * submit, then ask the SERVER's own judge what it thinks.
 */
function judge(seed, flaps, disguise, account) {
  disguise = disguise || {};
  const out = [];
  const rnd = mulberry32((seed ^ 0x5bf03635) >>> 0);
  let last = -Infinity;
  for (const f of flaps) {
    let t = f;
    if (disguise.jitterSteps) {
      t += Math.floor(rnd() * (disguise.jitterSteps * 2 + 1)) - disguise.jitterSteps;
    }
    if (t <= last) continue;
    if (last !== -Infinity && (t - last) < MIN_GAP_STEPS) continue;
    last = t;
    out.push(t);
  }
  let totalSteps = Math.max(60, (out.length ? out[out.length - 1] : 0) + 120);
  // A real cheat simply stops playing before the hard score cap, so the run
  // never trips it. Find the step at which the target score is reached.
  if (disguise.targetScore) {
    let lo = 60;
    let hi = totalSteps;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (P.simulate(seed, out, mid, []).score >= disguise.targetScore) hi = mid; else lo = mid + 1;
    }
    totalSteps = lo;
  }
  const replay = P.simulate(seed, out, totalSteps, []);
  const elapsedMs = totalSteps * STEP * 1000;      // cheat paces itself in real time
  const startedAt = Date.now() - elapsedMs;
  const heartbeats = [];
  for (let s = 0; s < totalSteps; s += 180) heartbeats.push({ at: startedAt + s * STEP * 1000, step: s });

  const verdict = AC.verdict({
    score: replay.score,
    totalSteps,
    flapLog: out,
    elapsedMs,
    heartbeats,
    startedAt,
    revivesUsed: 0,
    grantedRevives: 0,
    reviveAllowanceMs: 0,
    // Exactly what /api/submit-score now sends: the session seed (so the
    // server can test tap necessity) and the account's verified-run history.
    seed,
    account: account === undefined ? { verifiedRuns: 0, best: 0, firstRunAt: Date.now() } : account,
  });
  return { seed, flaps: out, totalSteps, score: replay.score, verdict, elapsedMs };
}

/**
 * CONTROL: a plausible HUMAN player model, not a solver. It sees the game
 * through a reaction delay, aims sloppily at the gap centre, and panic-taps.
 * Used to prove the autopilot detector does not fire on real play — if this
 * starts getting rejected, the thresholds are too tight.
 */
function humanRun(seed, opts) {
  opts = opts || {};
  const reaction = opts.reaction == null ? 12 : opts.reaction; // steps of lag
  const deadband = opts.deadband == null ? 22 : opts.deadband;
  const aimSlop = opts.aimSlop == null ? 18 : opts.aimSlop;
  const panic = opts.panic == null ? 0.05 : opts.panic;
  const maxSteps = opts.maxSteps || 12000;
  const rnd = mulberry32((seed ^ 0x2545f491) >>> 0);

  const st = freshState(seed);
  const flaps = [];
  let lastFlap = -Infinity;
  let aimOffset = (rnd() * 2 - 1) * aimSlop;

  for (let step = 0; step < maxSteps; step++) {
    const target = centreOfNext(st) + aimOffset;
    // Humans act on where the bird is GOING to be, not where it is — but their
    // lookahead is short and their aim drifts.
    let py = st.y;
    let pv = st.vy;
    for (let i = 0; i < reaction; i++) {
      pv += GRAVITY * STEP;
      if (pv > MAX_FALL_SPEED) pv = MAX_FALL_SPEED;
      py += pv * STEP;
      if (py - BIRD_R <= 0) { py = BIRD_R; pv = 0; }
    }
    // Tap when actually below the aim point and no longer climbing. This is
    // the bang-bang rhythm a thumb settles into; `py` above is only used to
    // keep the model from tapping into the floor.
    let want = (st.y > target + deadband) && (st.vy > -40);
    if (py > GROUND_Y - BIRD_R - 8) want = true;
    if (st.y + BIRD_R > GROUND_Y - 8) want = true;
    if (rnd() < panic) want = !want;
    if (rnd() < 0.02) aimOffset = (rnd() * 2 - 1) * aimSlop;

    const canFlap = (step - lastFlap) >= MIN_GAP_STEPS;
    const doFlap = want && canFlap;
    const crashed = stepState(st, doFlap);
    if (doFlap) { flaps.push(step); lastFlap = step; }
    if (crashed) break;
  }
  return { seed, flaps, score: st.score, totalSteps: Math.max(60, st.step) };
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

const SEEDS = [1000, 8917, 24601, 777777, 31337];
const DISGUISES = {
  'no disguise (raw solver, full run)': {},
  'stops before the hard cap (score 150)': { targetScore: 150 },
  'stops before the hard cap (score 55)': { targetScore: 55 },
  '+-3 step tap jitter': { jitterSteps: 3 },
};

// Who is running the bot matters as much as how: a farmed fresh account and a
// long-lived one face different score ceilings.
const ACCOUNTS = {
  'fresh alt-account': { verifiedRuns: 0, best: 0, firstRunAt: Date.now() },
  'long-lived account': { verifiedRuns: 500, best: 190, firstRunAt: Date.now() - 400 * 86400000 },
};

if (require.main === module) {
  const quiet = process.argv.includes('--quiet');
  const t0 = Date.now();
  let evaded = 0;
  let total = 0;
  for (const acctName of Object.keys(ACCOUNTS))
  for (const [name, disguise] of Object.entries(DISGUISES)) {
    const rows = [];
    for (const seed of SEEDS) {
      const s = solve(seed, { beam: Number(process.env.POC_BEAM) || 260 });
      const r = judge(seed, s.flaps, disguise, ACCOUNTS[acctName]);
      total++;
      if (r.verdict.ok) evaded++;
      rows.push({ seed, solved: r.score, accepted: r.verdict.ok, why: r.verdict.ok ? '-' : r.verdict.hard.join('+') });
    }
    const accepted = rows.filter((r) => r.accepted).length;
    const avg = Math.round(rows.reduce((a, r) => a + r.solved, 0) / rows.length);
    if (!quiet) {
      console.log('disguise:', name, '| account:', acctName);
      console.log('  ACCEPTED by server anti-cheat:', accepted + '/' + rows.length,
        '| avg submitted score', avg, '| hard cap', AC.MAX_SCORE);
      for (const r of rows) console.log('   seed', r.seed, '-> score', r.solved, r.accepted ? 'ACCEPTED' : ('rejected: ' + r.why));
    }
  }
  console.log('\nTOTAL: ' + evaded + '/' + total + ' scripted (solved) runs pass the current anti-cheat.  (' + (Date.now() - t0) + 'ms)');
  process.exitCode = evaded > 0 ? 1 : 0;
}

module.exports = { solve, judge, humanRun, SEEDS, DISGUISES, ACCOUNTS, mulberry32 };
