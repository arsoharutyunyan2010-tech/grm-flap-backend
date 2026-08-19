/**
 * GRM FLAP — shared deterministic physics engine.
 *
 * This file is loaded BOTH in the browser (client) and in Node.js (server).
 * The client uses it to actually run the game the player sees.
 * The server uses the EXACT same code to replay the player's inputs
 * (a seed + a list of "flap" steps) and compute the true score.
 *
 * Because both sides run identical code with identical fixed-point-in-time
 * steps and a seeded PRNG (instead of Math.random()), the simulation is
 * 100% reproducible. The server never trusts a score sent by the client —
 * it always recomputes it from the raw inputs.
 *
 * IMPORTANT: do not change these constants without also bumping
 * PHYSICS_VERSION, and make sure the client and server always load the
 * exact same file/version.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.GrmFlapPhysics = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PHYSICS_VERSION = 2;

  // ---- Fixed logical playfield (device-independent) ----
  var LOGICAL_W = 480;
  var LOGICAL_H = 800;

  // ---- Simulation constants (mirrors the original game feel) ----
  var STEP = 1 / 60;           // fixed timestep, seconds
  var GRAVITY = 1900;          // px/s^2
  var FLAP_VELOCITY = -480;    // px/s
  var MAX_FALL_SPEED = 900;
  var PIPE_GAP_BASE = 150;     // was 122 — wider vertical gap between top/bottom pipe
  var PIPE_GAP_MIN = 120;      // was 100 — never shrinks below this even at high score
  var PIPE_WIDTH = 62;
  var PIPE_SPEED_BASE = 195;
  var PIPE_INTERVAL_STEPS = Math.round(1.4 / STEP); // was 1.1 — more horizontal space between pipes
  var PIPE_MARGIN = 80;        // was 60 — keeps pipes further from screen top/bottom edges
  var PIPE_MAX_VERTICAL_JUMP = 150; // NEW — max px the next pipe's opening can shift vs the previous one
  var COIN_RADIUS = 16;
  var GROUND_HEIGHT = 70;
  var BIRD_X = LOGICAL_W * 0.32;
  var BIRD_START_Y = LOGICAL_H * 0.42;

  // Hard ceilings used as a sanity backstop (belt-and-braces anti-cheat,
  // independent of the replay itself).
  var MAX_STEPS_PER_SESSION = 60 * 60 * 20; // 20 minutes of play, generous cap
  var MAX_FLAPS_PER_SECOND = 6; // no human taps faster than this sustainably

  // ---- Seeded PRNG (mulberry32) so both sides draw identical "random" pipes ----
  function makeRng(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function currentGap(score) {
    return Math.max(PIPE_GAP_MIN, PIPE_GAP_BASE - Math.min(score, 20) * 1.5);
  }
  function currentSpeed(score) {
    return PIPE_SPEED_BASE + Math.min(score, 25) * 5;
  }

  // NEW — instead of a fully independent random top each time, clamp the
  // next pipe's opening to within PIPE_MAX_VERTICAL_JUMP of the previous
  // one. This removes the "sudden extreme high/low pipe" feel while still
  // being deterministic from the seeded rng.
  function nextPipeTop(rng, prevTop, gap, playH, margin) {
    var maxRange = playH - gap - margin * 2;
    if (prevTop === null || prevTop === undefined) {
      return margin + rng() * maxRange;
    }
    var lo = Math.max(margin, prevTop - PIPE_MAX_VERTICAL_JUMP);
    var hi = Math.min(margin + maxRange, prevTop + PIPE_MAX_VERTICAL_JUMP);
    if (hi < lo) hi = lo; // degenerate safety
    return lo + rng() * (hi - lo);
  }

  function circleRectCollide(cx, cy, cr, rx, ry, rw, rh) {
    var closestX = Math.max(rx, Math.min(cx, rx + rw));
    var closestY = Math.max(ry, Math.min(cy, ry + rh));
    var dx = cx - closestX;
    var dy = cy - closestY;
    return (dx * dx + dy * dy) < (cr * cr);
  }

  /**
   * Replays a full run from a seed and a set of step indices at which the
   * player flapped.
   *
   * @param {number} seed - session seed (issued by the server at session start)
   * @param {number[]} flapSteps - sorted array of step indices (0-based) at
   *        which a flap was applied, as recorded by the client input loop.
   * @param {number} maxSteps - hard cap on how many steps to simulate
   *        (server passes the number of real-time-elapsed steps allowed).
   * @returns {{score:number, crashedAtStep:number|null, steps:number, flapCount:number}}
   */
  function simulate(seed, flapSteps, maxSteps) {
    var rng = makeRng(seed);
    var flapSet = {};
    var flapCount = 0;
    var lastFlapStep = -Infinity;
    var minGapSteps = Math.floor((1 / MAX_FLAPS_PER_SECOND) / STEP);

    for (var i = 0; i < flapSteps.length; i++) {
      var s = flapSteps[i] | 0;
      if (s < 0) continue;
      // Reject/ignore physically-impossible tap rates instead of trusting them.
      if (s - lastFlapStep < minGapSteps) continue;
      lastFlapStep = s;
      flapSet[s] = true;
      flapCount++;
    }

    var cappedMax = Math.min(maxSteps | 0, MAX_STEPS_PER_SESSION);

    var bird = { x: BIRD_X, y: BIRD_START_Y, r: COIN_RADIUS, vy: FLAP_VELOCITY * 0.7 };
    var pipes = [];
    var score = 0;
    var pipeTimer = 0;
    var groundY = LOGICAL_H - GROUND_HEIGHT;
    var lastPipeTop = null;

    for (var step = 0; step < cappedMax; step++) {
      if (flapSet[step]) {
        bird.vy = FLAP_VELOCITY;
      }

      bird.vy += GRAVITY * STEP;
      if (bird.vy > MAX_FALL_SPEED) bird.vy = MAX_FALL_SPEED;
      bird.y += bird.vy * STEP;

      pipeTimer++;
      if (pipeTimer >= PIPE_INTERVAL_STEPS) {
        pipeTimer = 0;
        var gap = currentGap(score);
        var playH = LOGICAL_H - GROUND_HEIGHT;
        var top = nextPipeTop(rng, lastPipeTop, gap, playH, PIPE_MARGIN);
        lastPipeTop = top;
        pipes.push({ x: LOGICAL_W + PIPE_WIDTH, top: top, gap: gap, passed: false });
      }

      var speed = currentSpeed(score);
      var crashed = false;

      if (bird.y + bird.r >= groundY) {
        crashed = true;
      }
      if (bird.y - bird.r <= 0) {
        bird.y = bird.r;
        bird.vy = 0;
      }

      for (var p = pipes.length - 1; p >= 0; p--) {
        var pipe = pipes[p];
        pipe.x -= speed * STEP;
        if (!pipe.passed && pipe.x + PIPE_WIDTH < bird.x - bird.r) {
          pipe.passed = true;
          score++;
        }
        if (pipe.x < -PIPE_WIDTH - 10) {
          pipes.splice(p, 1);
          continue;
        }
        if (!crashed && bird.x + bird.r > pipe.x && bird.x - bird.r < pipe.x + PIPE_WIDTH) {
          var bottomY = pipe.top + pipe.gap;
          if (circleRectCollide(bird.x, bird.y, bird.r * 0.85, pipe.x, 0, PIPE_WIDTH, pipe.top)) crashed = true;
          if (circleRectCollide(bird.x, bird.y, bird.r * 0.85, pipe.x, bottomY, PIPE_WIDTH, groundY - bottomY)) crashed = true;
        }
      }

      if (crashed) {
        return { score: score, crashedAtStep: step, steps: step + 1, flapCount: flapCount };
      }
    }

    // Ran out of allotted steps without crashing (e.g. still flying) —
    // valid mid-game state, not a crash.
    return { score: score, crashedAtStep: null, steps: cappedMax, flapCount: flapCount };
  }

  return {
    VERSION: PHYSICS_VERSION,
    STEP: STEP,
    LOGICAL_W: LOGICAL_W,
    LOGICAL_H: LOGICAL_H,
    GROUND_HEIGHT: GROUND_HEIGHT,
    PIPE_WIDTH: PIPE_WIDTH,
    COIN_RADIUS: COIN_RADIUS,
    BIRD_X: BIRD_X,
    BIRD_START_Y: BIRD_START_Y,
    GRAVITY: GRAVITY,
    FLAP_VELOCITY: FLAP_VELOCITY,
    MAX_FALL_SPEED: MAX_FALL_SPEED,
    MAX_FLAPS_PER_SECOND: MAX_FLAPS_PER_SECOND,
    MAX_STEPS_PER_SESSION: MAX_STEPS_PER_SESSION,
    PIPE_MARGIN: PIPE_MARGIN,
    makeRng: makeRng,
    currentGap: currentGap,
    currentSpeed: currentSpeed,
    nextPipeTop: nextPipeTop,
    simulate: simulate
  };
});
