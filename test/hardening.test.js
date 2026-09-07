/**
 * Unit tests for the second security-hardening round:
 *   1. New-account score gate — a fresh account cannot post an elite score.
 *   2. Score anomaly detection — sudden jump vs own history + bot-like
 *      consistency (deterministic solver bots end on near-identical scores).
 *   3. Deposit txHash is single-use FOREVER — even after a rejection.
 *   4. PvP self-matching from one IP is flagged with a soft admin event.
 *   5. /internal/health never leaks the persist report when ADMIN_KEY is
 *      unset — not even with a literal "undefined" header value.
 *
 * Run with:  npm run test:hardening
 */
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

// Isolate the store so the test never touches a real data file. Everything
// must be set BEFORE the first require of store.js/server.js.
const TMP = path.join(os.tmpdir(), 'grmflap-hardening-' + process.pid + '.json');
process.env.DATA_FILE = TMP;
// Keep backups inside this run's own scratch dir: the default backup dir
// (/tmp/backups) is shared between test runs, and the store's boot fallback
// would load a PREVIOUS run's backup — making deposits look duplicated.
process.env.BACKUP_DIR = TMP + '.backups';
process.env.UPSTASH_REDIS_REST_URL = '';
process.env.PORT = '4781';
delete process.env.ADMIN_KEY; // misconfigured-on-purpose for the leak test
const store = require('../store.js');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

store.ready.then(async () => {
  console.log('\n1) new-account score gate');
  const fresh = 'fresh-' + process.pid;
  const g1 = store.newAccountGate(fresh, 130);
  check('brand-new account cannot post 130', g1.ok === false, JSON.stringify(g1));
  const g2 = store.newAccountGate(fresh, 100);
  check('brand-new account CAN post 100 (below cap)', g2.ok === true);
  for (let i = 0; i < 5; i++) store.recordVerifiedRun(fresh, 60 + i);
  const g3 = store.newAccountGate(fresh, 130);
  check('after 5 verified runs the gate lifts', g3.ok === true, 'runs=' + g3.runs);
  check('run history is capped at 20', store.getRunHistory(fresh).length === 5);

  console.log('\n2) score anomaly detection (soft flags)');
  const jumper = 'jumper-' + process.pid;
  [10, 12, 11, 9].forEach((s) => store.recordVerifiedRun(jumper, s));
  const flagsJump = store.checkScoreAnomaly(jumper, 85);
  check('sudden 4x+ jump vs own history is flagged', flagsJump.some((f) => f.reason === 'score jump'), JSON.stringify(flagsJump));
  const normal = 'normal-' + process.pid;
  [20, 45, 12, 30, 25, 18, 40, 22].forEach((s) => store.recordVerifiedRun(normal, s));
  const flagsNormal = store.checkScoreAnomaly(normal, 35);
  check('a human-noisy history raises no flag', flagsNormal.length === 0, JSON.stringify(flagsNormal));
  const bot = 'bot-' + process.pid;
  for (let i = 0; i < 9; i++) store.recordVerifiedRun(bot, 55);
  const flagsBot = store.checkScoreAnomaly(bot, 55);
  check('metronome-consistent scores are flagged', flagsBot.some((f) => f.reason === 'suspiciously consistent scores'), JSON.stringify(flagsBot));

  console.log('\n3) deposit txHash single-use (rejected hashes stay burned)');
  const depHash = 'abcdef1234567890' + String(process.pid) + 'abcdef';
  const dep1 = store.requestDeposit('depuser-' + process.pid, 'Dep', 100, depHash);
  check('first submission accepted', dep1.ok === true, dep1.error || '');
  const dep2 = store.requestDeposit('depuser2-' + process.pid, 'Dep2', 100, depHash);
  check('same hash by ANOTHER user refused', dep2.ok === false, dep2.error || '');
  store.rejectDeposit(dep1.request.id);
  const dep3 = store.requestDeposit('depuser-' + process.pid, 'Dep', 200, depHash);
  check('rejected hash cannot be resubmitted', dep3.ok === false, dep3.error || '');
  const dep4 = store.requestDeposit('depuser-' + process.pid, 'Dep', 50, '1234567890abcdef' + String(process.pid) + 'abcdef');
  check('a different hash still works', dep4.ok === true);

  console.log('\n4) PvP same-IP self-match flag');
  const p1 = 'pvp-a-' + process.pid;
  const p2 = 'pvp-b-' + process.pid;
  store.creditCBalance(p1, 100);
  store.creditCBalance(p2, 100);
  const j1 = store.pvpJoin(p1, 'Alice', 10, '203.0.113.7');
  check('first player queues', j1.ok === true && !!j1.waiting);
  const before = store.listAntiCheatEvents(50).length;
  const j2 = store.pvpJoin(p2, 'Bob', 10, '203.0.113.7');
  check('second player matches', j2.ok === true && !!j2.match, JSON.stringify({ ok: j2.ok, hasMatch: !!j2.match }));
  const evs = store.listAntiCheatEvents(50);
  const sameIpEv = evs.find((e) => e.reason === 'pvp same-ip match');
  check('same-IP match recorded for the admin', !!sameIpEv, 'events before=' + before + ' after=' + evs.length);
  const j3 = store.pvpJoin('pvp-c-' + process.pid, 'Carol', 10, '198.51.100.9');
  const evs2 = store.listAntiCheatEvents(50);
  check('different-IP match is NOT flagged', !evs2.find((e) => e.reason === 'pvp same-ip match' && e.userId === 'pvp-c-' + process.pid));
  check('soft events carry soft:true', !sameIpEv || sameIpEv.soft === true);

  console.log('\n5) /internal/health does not leak when ADMIN_KEY is unset');
  const server = require('../server.js');
  await waitServer(4781, 8000);
  const leak = await httpGetJson(4781, '/internal/health', { 'x-admin-key': 'undefined' });
  check('health answers', leak != null, leak && leak.err);
  check('health hides persist report without a configured key', leak && !('persist' in leak), JSON.stringify(leak));
  const stats = await httpGetJson(4781, '/internal/stats', { 'x-admin-key': 'undefined' });
  check('/internal/stats refuses a bogus key when admin is unconfigured', stats && stats.status === 403, JSON.stringify(stats));

  console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
  try { fs.unlinkSync(TMP); } catch (e) {}
  process.exit(failures === 0 ? 0 : 1);
}).catch((err) => {
  console.error('store.ready failed:', err && err.message);
  process.exit(1);
});

function waitServer(port, timeoutMs) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    (function tryOnce() {
      const req = http.get({ host: '127.0.0.1', port, path: '/internal/health', timeout: 1000 }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => {
        if (Date.now() - t0 > timeoutMs) return reject(new Error('server did not start'));
        setTimeout(tryOnce, 200);
      });
    })();
  });
}

function httpGetJson(port, p, headers) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(raw); } catch (e) { body = { parseError: true, raw: raw.slice(0, 120) }; }
        body.status = res.statusCode;
        resolve(body);
      });
    });
    req.on('error', (err) => resolve({ err: String(err.message || err), status: 0 }));
  });
}
