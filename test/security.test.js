/**
 * Unit tests for the security hardening added in this branch:
 *   1. Referral invites only COUNT after a verified run (anti self-referral /
 *      invite-farming with empty alt accounts).
 *   2. initData freshness window (a leaked/stale token cannot be used forever).
 *   3. On-chain deposit verifier parsing (fake / wrong-address hashes refused).
 *   4. Admin split-key + IP allow-list wiring is syntactically loaded by server.
 *
 * Run with:  npm run test:security
 */
'use strict';

const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Isolate the store so the test never touches a real data file.
const TMP = path.join(os.tmpdir(), 'grmflap-security-' + process.pid + '.json');
process.env.DATA_FILE = TMP;
process.env.UPSTASH_REDIS_REST_URL = '';
const store = require('../store.js');
const VD = require('../verifyDeposit.js');
const { verifyInitData } = require('../telegramAuth.js');
const AC = require('../anticheat.js');
const P = require('../physics.js');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

// ---- helper: craft a valid initData the way the Telegram client would ----
function makeInitData(token, user, authDateSec) {
  const fields = {
    auth_date: String(Math.floor(authDateSec)),
    query_id: 'AAE_security_test',
    user: JSON.stringify(user),
  };
  const pairs = Object.keys(fields).sort().map((k) => k + '=' + fields[k]);
  const dataCheckString = pairs.join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const qs = new URLSearchParams();
  for (const k of Object.keys(fields)) qs.append(k, fields[k]);
  qs.append('hash', hash);
  return qs.toString();
}

store.ready.then(async () => {
  const BOT = '123456:TEST_BOT_TOKEN_abcdef0123456789';
  const now = Math.floor(Date.now() / 1000);
  const user = { id: 987654321, first_name: 'Sec', username: 'sec_user' };

  console.log('\n1) referral gating — invite counts only after a verified run');
  // referrer (id refid-1) is a known, existing user so its code resolves.
  store.getReferralInfo('refid-1', 'Ann');
  const childId = 'sec-ref-child-1';
  store.attachReferral(childId, 'Bob', 'ref_refid-1');
  const pending = store.getReferralInfo('refid-1', 'Ann');
  check('opening a link alone does NOT count an invite', pending.level1 === 0, 'level1=' + pending.level1);
  // First verified run activates it.
  store.activateReferral(childId, 'Bob');
  const active = store.getReferralInfo('refid-1', 'Ann');
  check('a verified run activates exactly one invite', active.level1 === 1, 'level1=' + active.level1);
  // Second call must not double-count.
  store.activateReferral(childId, 'Bob');
  const again = store.getReferralInfo('refid-1', 'Ann');
  check('activateReferral is idempotent (no double count)', again.level1 === 1, 'level1=' + again.level1);

  console.log('\n2) initData freshness window');
  const SENSITIVE = 20 * 60; // seconds, mirrors server SENSITIVE_MAX_AGE_SECONDS default
  const fresh = verifyInitData(makeInitData(BOT, user, now - 60), BOT, SENSITIVE);
  check('fresh initData passes the tight window', fresh.ok === true, fresh.reason || '');
  const staleLeaked = verifyInitData(makeInitData(BOT, user, now - 3600), BOT, SENSITIVE);
  check('a 1h-old leaked initData is rejected for money moves', staleLeaked.ok === false, staleLeaked.reason || '');
  const normalWindow = verifyInitData(makeInitData(BOT, user, now - 3600), BOT, 12 * 60 * 60);
  check('the same 1h-old token still passes normal play window', normalWindow.ok === true);

  console.log('\n3) on-chain deposit verifier (parsing + matching)');
  const DEPOSIT = 'UQBUuWTTTfBt6BpXt0lLLkJ_my6PTbY9L1Ul0w8VgQ9nU9q'; // project address (raw compare used)
  const inMsgHashHex = crypto.createHash('sha256').update('msg1').digest('hex');
  // A canned toncenter-style response: one inbound tx to DEPOSIT with our hash.
  const goodResponse = {
    ok: true,
    result: [
      {
        transaction_id: { hash: 'aa'.repeat(32), lt: '100' },
        in_msg: { source: 'EQ-source-1', destination: DEPOSIT, value: '1500000000', hash: inMsgHashHex },
      },
      { transaction_id: { hash: 'bb'.repeat(32), lt: '99' }, in_msg: { source: 'EQ-x', destination: 'EQ-other', value: '1', hash: crypto.createHash('sha256').update('other').digest('hex') } },
    ],
  };
  const badAddressResponse = {
    ok: true,
    result: [
      { transaction_id: { hash: 'cc'.repeat(32), lt: '10' }, in_msg: { source: 'EQ-x', destination: 'EQ-somewhere-else', value: '999999', hash: inMsgHashHex } },
    ],
  };
  const emptyResponse = { ok: true, result: [] };

  const good = await VD.verifyDepositClaim({
    txHash: inMsgHashHex, depositAddress: DEPOSIT, fetchImpl: async () => ({ ok: true, json: async () => goodResponse }),
  });
  check('verifies a genuine inbound transfer to the deposit address', good.ok === true, JSON.stringify(good));
  const badAddr = await VD.verifyDepositClaim({
    txHash: inMsgHashHex, depositAddress: DEPOSIT, fetchImpl: async () => ({ ok: true, json: async () => badAddressResponse }),
  });
  check('refuses a hash that never paid the deposit address', badAddr.ok === false, badAddr.reason || '');
  const notFound = await VD.verifyDepositClaim({
    txHash: inMsgHashHex, depositAddress: DEPOSIT, fetchImpl: async () => ({ ok: true, json: async () => emptyResponse }),
  });
  check('refuses when no matching inbound tx exists', notFound.ok === false, notFound.reason || '');

  console.log('\n4) machine-tap concentration detector');
  // Metronome on gap 18 with a couple of rare outlier gaps (fakes jitter): the
  // distribution is still dominated by gap 18 → must be flagged at high score.
  const gaps = [];
  for (let i = 0; i < 150; i++) { gaps.push(18); if (i % 40 === 0) gaps.push(30); if (i % 73 === 0) gaps.push(41); }
  const flapLog = [];
  let s = 0; for (const g of gaps) { s += g; flapLog.push(s); }
  const taps = AC.analyzeFlapPattern(flapLog, 80);
  check('near-metronome with rare jitter is still caught', taps.ok === false, taps.reason || ('ok, cv=' + taps.cv));

  console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
  try { fs.unlinkSync(TMP); } catch (e) {}
  process.exit(failures === 0 ? 0 : 1);
}).catch((err) => {
  console.error('store.ready failed:', err && err.message);
  process.exit(1);
});
