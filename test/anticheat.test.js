/**
 * Anti-cheat unit tests — run with:  npm run test:anticheat
 */
const AC = require('../anticheat.js');
const P = require('../physics.js');
const { verifyInitData } = require('../telegramAuth.js');
const { runWeeklyRewardJob, grmForRank } = require('../rewards.js');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

console.log('\n1) input sanitization');
check('drops non-arrays', AC.sanitizeIntArray({ 0: 1 }, 10).length === 0);
check('drops NaN / objects / negatives', AC.sanitizeIntArray([1, 'x', NaN, -4, 2, 2, 9], 20).join(',') === '1,2,9');
check('caps length', AC.sanitizeIntArray(new Array(50).fill(1).map((_, i) => i), 8).length === 8);
check('name strips tags', AC.sanitizeName('<script>xss</script>hi') === 'scriptxss/scripthi' || AC.sanitizeName('<b>Bob</b>').indexOf('<') < 0);
check('name fallback', AC.sanitizeName('   ') === 'Player');
check('tx hash rejects junk', AC.sanitizeTxHash('$$$$') === '');
check('tx hash lowercases', AC.sanitizeTxHash('ABCDEF12') === 'abcdef12');

console.log('\n2) session HMAC token');
AC.setSessionSecret('test-secret-key-for-hmac');
const tok = AC.sessionToken('sid', '42', 99);
check('token is hex-ish', /^[0-9a-f]{40}$/.test(tok));
check('token matches', AC.tokensMatch(tok, AC.sessionToken('sid', '42', 99)));
check('token rejects other user', !AC.tokensMatch(tok, AC.sessionToken('sid', '43', 99)));
check('token rejects empty', !AC.tokensMatch('', tok));
check('safeEqual same', AC.safeEqual('abcdef', 'abcdef'));
check('safeEqual different', !AC.safeEqual('abcdef', 'abcdeg'));
check('safeEqual empty is false', !AC.safeEqual('', ''));

console.log('\n3) wall-clock timing');
const longSteps = Math.round(60 * 10 / P.STEP); // 10 seconds of sim ~ 600 steps? wait STEP=1/60 so 10s = 600
check('10s sim in 10s wall is ok', AC.checkTiming(600, 10000, 0).ok === true);
check('10s sim submitted instantly is rejected', AC.checkTiming(600, 50, 0).ok === false);
check('allowedSteps tracks wall clock', AC.allowedStepsFor(1000, 0) < 200);

console.log('\n4) flap metronome (bot) vs human jitter');
const minGap = AC.MIN_FLAP_GAP_STEPS;
const botFlaps = [];
for (let i = 0; i < 80; i++) botFlaps.push(30 + i * minGap);
const bot = AC.analyzeFlapPattern(botFlaps, 50);
check('perfect min-gap flaps rejected', bot.ok === false, JSON.stringify(bot));

const humanFlaps = [];
let t = 20;
for (let i = 0; i < 80; i++) {
  t += minGap + 4 + ((i * 7) % 17);
  humanFlaps.push(t);
}
const human = AC.analyzeFlapPattern(humanFlaps, 50);
check('jittered flaps accepted', human.ok === true, JSON.stringify(human));

const short = AC.analyzeFlapPattern([10, 25, 40], 5);
check('short runs not judged', short.ok === true);

// A solver bot that flaps on a LONGER constant interval with ±1 step jitter
// (stdev ~0.8 but only 2 distinct gaps) used to slip past the min-gap check.
const jitterBot = [];
let jt = 30;
for (let i = 0; i < 140; i++) { jt += (i % 2 ? 18 : 19); jitterBot.push(jt); }
const jb = AC.analyzeFlapPattern(jitterBot, 100);
check('±1-step jittered metronome rejected', jb.ok === false, JSON.stringify({ reason: jb.reason, cv: jb.cv, u: jb.uniqueGaps }));

// Long run with only 3 distinct inter-flap intervals.
const threeGap = [];
let gt = 30;
for (let i = 0; i < 120; i++) { gt += [15, 16, 17][i % 3]; threeGap.push(gt); }
const tg = AC.analyzeFlapPattern(threeGap, 90);
check('3-unique-gap long run rejected', tg.ok === false, tg.reason);

// Genuinely irregular human play over a high-scoring run must still pass.
const humanHigh = [];
let ht = 20;
for (let i = 0; i < 160; i++) {
  ht += 14 + Math.floor(Math.abs(Math.sin(i * 2.7)) * 10) + (i % 7 === 0 ? 6 : 0) + (i % 11 === 0 ? 4 : 0);
  humanHigh.push(ht);
}
const hh = AC.analyzeFlapPattern(humanHigh, 120);
check('irregular human high-score run accepted', hh.ok === true, JSON.stringify({ cv: hh.cv && hh.cv.toFixed(2), u: hh.uniqueGaps }));

// clientIp must use the proxy-trusted socket-side address, never the
// client-supplied left-most X-Forwarded-For entry.
const fakeReq = {
  ip: '203.0.113.7',
  headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.7' },
  socket: { remoteAddress: '10.0.0.1' },
};
check('clientIp trusts req.ip not spoofed XFF', AC.clientIp(fakeReq) === '203.0.113.7', AC.clientIp(fakeReq));
check('clientIp falls back without req.ip', AC.clientIp({ socket: { remoteAddress: '9.9.9.9' } }) === '9.9.9.9');

console.log('\n5) heartbeats');
const started = Date.now() - 40000;
const beats = [];
for (let i = 0; i < 10; i++) beats.push({ at: started + i * 4000, step: i * 240 });
check(
  'covering heartbeats ok',
  AC.checkHeartbeats(beats, started, 40000, 2400).ok === true
);
check(
  'no heartbeats on a long run rejected',
  AC.checkHeartbeats([], started, 40000, 2400).ok === false
);
check(
  'short run without heartbeats ok',
  AC.checkHeartbeats([], started, 5000, 200).ok === true
);
check(
  'idle pings then huge step dump rejected',
  AC.checkHeartbeats(
    [{ at: started + 1000, step: 0 }, { at: started + 2000, step: 1 }],
    started, 40000, 2400
  ).ok === false
);

// Long run: heartbeats that end far before the final step are a precomputed
// dump (the client only pinged early, then sent a scripted perfect log).
const longRun = 60 * 60 * 2; // ~2 minutes of sim = 7200 steps
const longBeats = [];
for (let i = 0; i < 30; i++) longBeats.push({ at: started + i * 3000, step: i * 180 });
// beats reach ~5220 but run claims 7200
check(
  'long run with heartbeats stopping early is rejected',
  AC.checkHeartbeats(longBeats, started - 90000, 90000, longRun).ok === false
);
// ...while the same cadence that reaches the end passes (within 480 steps).
const coverBeats = [];
for (let i = 0; i < 42; i++) coverBeats.push({ at: started - 90000 + i * 2100, step: Math.min(longRun - 100, i * 175) });
check(
  'long run with heartbeats reaching near the end accepted',
  AC.checkHeartbeats(coverBeats, started - 90000, 90000, longRun).ok === true
);

console.log('\n6) full verdict');
const vBot = AC.verdict({
  score: 50,
  totalSteps: 2400,
  flapLog: botFlaps,
  elapsedMs: 40000,
  heartbeats: beats,
  startedAt: started,
  revivesUsed: 0,
  grantedRevives: 0,
});
check('bot cadence verdict rejects', vBot.ok === false, (vBot.hard || []).join(','));

const vHuman = AC.verdict({
  score: 12,
  totalSteps: 400,
  flapLog: [20, 45, 80, 130],
  elapsedMs: 8000,
  heartbeats: [],
  startedAt: Date.now() - 8000,
  revivesUsed: 0,
  grantedRevives: 0,
});
check('short human run accepted', vHuman.ok === true, (vHuman.hard || []).join(','));

const vRevive = AC.verdict({
  score: 10,
  totalSteps: 300,
  flapLog: [20, 50],
  elapsedMs: 6000,
  heartbeats: [],
  startedAt: Date.now() - 6000,
  revivesUsed: 2,
  grantedRevives: 0,
});
check('unearned revives rejected', vRevive.ok === false && vRevive.hard.indexOf('unearned revive') >= 0);

const vCap = AC.verdict({
  score: 9999,
  totalSteps: 200,
  flapLog: [1, 20],
  elapsedMs: 5000,
  heartbeats: [],
  startedAt: Date.now() - 5000,
  revivesUsed: 0,
  grantedRevives: 0,
});
check('score hard cap', vCap.ok === false);

console.log('\n7) physics replay is the only score source');
const seed = 12345;
const flaps = [8, 25, 50, 80, 120];
const a = P.simulate(seed, flaps, 400, []);
const b = P.simulate(seed, flaps, 400, []);
check('replay is deterministic', a.score === b.score && a.crashedAtStep === b.crashedAtStep);
const withRevive = P.simulate(seed, flaps, 400, [a.crashedAtStep]);
check('revive can only help at the crash step', withRevive.revivesUsed <= 1);
// Extra forged revives beyond MAX_REVIVES are ignored.
const forged = P.simulate(seed, flaps, 2000, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
check('extra revives capped by physics MAX_REVIVES', forged.revivesUsed <= P.MAX_REVIVES);

console.log('\n8) telegram auth fails closed');
check('missing token rejected', verifyInitData('hash=abc', '', 60).ok === false);
check('missing initData rejected', verifyInitData('', 'tok', 60).ok === false);
check('junk initData rejected', verifyInitData('user=1&hash=00', 'tok', 60).ok === false);

console.log('\n9) weekly rewards are idempotent + pay previous week');
const fakePaid = [];
const fakeStore = {
  previousWeekKey: () => '2026-W01',
  currentWeekKey: () => '2026-W02',
  weekAlreadyPaid: (k) => k === '2026-W01',
  getLeaderboard: () => ({ ranked: [{ userId: '1', rank: 1, score: 99 }] }),
  creditBalance: (uid, n) => fakePaid.push([uid, n]),
  archiveWeek: () => {},
};
const skipped = runWeeklyRewardJob(fakeStore);
check('already-paid week is skipped', skipped.skipped === true && fakePaid.length === 0);
check('rank 1 payout amount', grmForRank(1) === 5000);
check('rank 99 payout is 0', grmForRank(99) === 0);

console.log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED'));
process.exit(failures ? 1 : 0);
