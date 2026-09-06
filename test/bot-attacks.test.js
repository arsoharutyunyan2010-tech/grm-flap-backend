/**
 * Adversarial tests: do the anti-cheat and money-fraud controls actually stop
 * the attacks described in SECURITY_REVIEW.md?
 *
 * These are NOT polite unit tests. `security/solver-poc.js` really solves the
 * game from the public seed and the tests assert the server refuses to pay for
 * it. If a control is ever weakened, one of these goes red.
 *
 * Run with:  npm run test:bot
 */
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

// Configure the money-fraud gates before the store reads them.
process.env.DATA_FILE = path.join(os.tmpdir(), 'grmflap-bot-' + process.pid + '.json');
process.env.UPSTASH_REDIS_REST_URL = '';
process.env.WITHDRAW_MIN_ACCOUNT_AGE_MS = '0';
process.env.REFERRAL_COMMISSION_DAILY_CAP_C = '100';
process.env.REFERRAL_COMMISSION_MIN_DEPOSITOR_AGE_MS = '0';

const store = require('../store.js');
const AC = require('../anticheat.js');
const P = require('../physics.js');
const POC = require('../security/solver-poc.js');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra !== undefined && extra !== '' ? '  ' + extra : ''));
  if (!cond) failures++;
}

const SEED = 4242;
const solved = POC.solve(SEED, { beam: 40, maxSteps: 6000 });
const FRESH = { verifiedRuns: 0, best: 0, firstRunAt: Date.now() };
const TRUSTED = { verifiedRuns: 500, best: 80, firstRunAt: Date.now() - 300 * 86400000 };

store.ready.then(() => {
  console.log('\n1) the game is genuinely solvable by a script (the threat is real)');
  check('solver beats the fresh-account ceiling', solved.score > AC.SCORE_GATE.newAccountCap,
    'solved score=' + solved.score + ', cap=' + AC.SCORE_GATE.newAccountCap);

  console.log('\n2) a solved run cannot be banked by a fresh alt-account');
  const onFresh = POC.judge(SEED, solved.flaps, {}, FRESH);
  check('fresh account: solved run rejected', onFresh.verdict.ok === false,
    onFresh.verdict.hard.join('+'));
  check('fresh account: rejected for the score, not by luck',
    onFresh.verdict.hard.indexOf('score implausible for this account') >= 0);

  console.log('\n3) a solved run cannot be banked by an established account either');
  const onTrusted = POC.judge(SEED, solved.flaps, {}, TRUSTED);
  const ceiling = AC.scoreCeilingFor(TRUSTED);
  check('trusted account: ceiling grows with history', ceiling > AC.SCORE_GATE.newAccountCap,
    'ceiling=' + ceiling);
  if (solved.score > ceiling) {
    check('trusted account: solved run still rejected', onTrusted.verdict.ok === false,
      onTrusted.verdict.hard.join('+'));
  } else {
    check('trusted account: run inside its earned ceiling is allowed (no false ban)',
      onTrusted.verdict.ok === true, 'score=' + solved.score + ' ceiling=' + ceiling);
  }

  console.log('\n4) the absolute cap is now inside human reach');
  const overCap = AC.verdict({
    score: AC.MAX_SCORE + 50, totalSteps: 1000, flapLog: solved.flaps.slice(0, 80),
    elapsedMs: 20000, heartbeats: [], startedAt: Date.now() - 20000,
    revivesUsed: 0, grantedRevives: 0, seed: SEED, account: TRUSTED,
  });
  check('score above SCORE_HARD_CAP rejected', overCap.ok === false,
    'MAX_SCORE=' + AC.MAX_SCORE + ' -> ' + overCap.hard.join('+'));

  console.log('\n5) a normal, low human score is NOT rejected');
  const human = AC.verdict({
    score: 14, totalSteps: 900, flapLog: [20, 55, 90, 140, 190, 240, 300, 350, 410, 470],
    elapsedMs: 15000, heartbeats: [], startedAt: Date.now() - 15000,
    revivesUsed: 0, grantedRevives: 0, seed: SEED, account: FRESH,
  });
  check('ordinary run accepted', human.ok === true, human.hard.join('+'));
  check('machine-precision telemetry stays advisory (never in hard)',
    human.hard.indexOf('autopilot tap stream') < 0 && human.hard.indexOf('machine-precision play') < 0);

  console.log('\n6) two accounts submitting the identical solved run = shared bot');
  const a = store.checkFlapSignature('bot-acct-A', SEED, solved.flaps, solved.score);
  check('first submission is not a duplicate', a.duplicate === false);
  const b = store.checkFlapSignature('bot-acct-B', SEED, solved.flaps, solved.score);
  check('second account with the same taps IS flagged', b.duplicate === true,
    'otherUserId=' + b.otherUserId);
  const c = store.checkFlapSignature('bot-acct-A', SEED + 1, solved.flaps, solved.score);
  check('same taps on a DIFFERENT seed is not flagged', c.duplicate === false);

  console.log('\n7) withdrawal gates');
  store.creditBalance('w-fresh', 5000);
  const w1 = store.requestWithdrawal('w-fresh', 'Fresh', 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE', 100);
  check('brand-new account cannot cash out', w1.ok === false, w1.error);
  for (let i = 0; i < store.WITHDRAW_MIN_VERIFIED_RUNS; i++) store.recordVerifiedRun('w-aged', 5 + i);
  store.creditBalance('w-aged', 5000);
  const w2 = store.requestWithdrawal('w-aged', 'Aged', 'EQBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', 100);
  check('an account with verified runs can', w2.ok === true, w2.error || ('id=' + w2.request.id));

  const shared = 'EQCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
  let blockedAt = -1;
  for (let i = 0; i < 8; i++) {
    const uid = 'mule-' + i;
    for (let k = 0; k < store.WITHDRAW_MIN_VERIFIED_RUNS; k++) store.recordVerifiedRun(uid, 3);
    store.creditBalance(uid, 5000);
    const r = store.requestWithdrawal(uid, 'M' + i, shared, 50);
    if (!r.ok && blockedAt < 0) blockedAt = i;
  }
  check('one payout address cannot serve an unlimited pile of accounts', blockedAt > 0,
    'blocked at account #' + blockedAt);

  console.log('\n8) deposit fraud');
  const d1 = store.requestDeposit('dep-1', 'Dep', 100, 'deadbeefdeadbeef');
  check('deposit accepted first time', d1.ok === true);
  store.rejectDeposit(d1.request.id);
  const d2 = store.requestDeposit('dep-1', 'Dep', 100, 'deadbeefdeadbeef');
  check('a REJECTED tx hash cannot be resubmitted', d2.ok === false, d2.error);
  const d3 = store.requestDeposit('dep-2', 'Other', 100, 'deadbeefdeadbeef');
  check('nor claimed by a different account', d3.ok === false, d3.error);

  console.log('\n9) referral commission abuse');
  store.getReferralInfo('up-line', 'Up');
  store.attachReferral('down-line', 'Down', 'ref_up-line');
  store.activateReferral('down-line', 'Down');
  store.recordVerifiedRun('down-line', 5);
  // Real path: an approved deposit is what pays the upline (7% level-1).
  const big = store.requestDeposit('down-line', 'Down', 100000, 'feedfacefeedface');
  check('top-up request created', big.ok === true, big.error || '');
  const before = store.getCBalance('up-line');
  const approved = store.approveDeposit(big.request.id);
  const capped = store.getCBalance('up-line') - before;
  check('deposit credits the depositor', approved && approved.cBalance === 100000,
    'cBalance=' + (approved && approved.cBalance));
  check('referral commission is capped per day', capped <= 100,
    'paid=' + capped + ' (uncapped 7% would be 7000)');

  console.log('\n10) admin TOTP second factor');
  const SECRET = 'JBSWY3DPEHPK3PXP';
  const code = AC.totpCode(SECRET);
  check('generated code is 6 digits', /^[0-9]{6}$/.test(code), code);
  check('the current code validates', AC.totpValid(SECRET, code) === true);
  check('a wrong code is refused', AC.totpValid(SECRET, '000000') === false || code === '000000');
  check('an empty code is refused', AC.totpValid(SECRET, '') === false);
  check('no secret configured => no second factor (backwards compatible)',
    AC.totpValid('', '123456') === false);

  console.log('\n11) machine-precision telemetry is computed for review');
  const tel = POC.judge(SEED, solved.flaps, {}, TRUSTED).verdict;
  check('redundancy metric present', tel.redundancy && tel.redundancy.sampled > 0,
    JSON.stringify(tel.redundancy));
  check('rigidity metric present', tel.rigidity && tel.rigidity.skipped === false,
    JSON.stringify(tel.rigidity));

  console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
  try { fs.unlinkSync(process.env.DATA_FILE); } catch (e) {}
  process.exit(failures === 0 ? 0 : 1);
}).catch((err) => {
  console.error('store.ready failed:', err && err.stack);
  process.exit(1);
});
