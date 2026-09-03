/**
 * Persistence safety tests — run with:  npm run test:persistence
 *
 * Verifies that player balances / referrals / leaderboard rows survive
 * restarts, deploy overlaps and storage outages.
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 7997;
const RUN = 't' + Date.now();          // unique ids so repeated runs stay independent
const U1 = RUN + 'a', U2 = RUN + 'b', U3 = RUN + 'c', U4 = RUN + 'd', U5 = RUN + 'e';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flap-persist-'));
let failures = 0;

function check(name, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function runScenario(code, env) {
  const res = spawnSync(process.execPath, ['-e', code], {
    env: Object.assign({}, process.env, {
      UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:' + PORT,
      UPSTASH_REDIS_REST_TOKEN: 'test',
      DATA_FILE: path.join(TMP, 'store.json'),
      STORE_REDIS_KEY: 'test:store',
      T_U1: U1, T_U2: U2, T_U3: U3, T_U4: U4, T_U5: U5,
    }, env || {}),
    encoding: 'utf8',
    timeout: 60000,
  });
  const out = (res.stdout || '') + (res.stderr || '');
  const m = out.match(/RESULT (.*)/);
  if (!m) { console.log(out); return {}; }
  return JSON.parse(m[1]);
}

const STORE = JSON.stringify(path.join(__dirname, '..', 'store.js'));

const mock = spawn(process.execPath, [path.join(__dirname, 'mock-upstash.js')], {
  env: Object.assign({}, process.env, { MOCK_PORT: String(PORT) }),
  stdio: 'ignore',
});

setTimeout(() => {
  console.log('\n1) write then restart keeps balances, referrals and scores');
  runScenario(`
    const store = require(${STORE});
    (async () => {
      await store.ready;
      store.trackUser(process.env.T_U1, 'Ann'); store.creditBalance(process.env.T_U1, 500);
      store.submitPeriodScores(process.env.T_U2, 'Bob', 99999);
      store.getReferralInfo(process.env.T_U1, 'Ann');
      store.attachReferral(process.env.T_U3, 'Cid', 'ref_' + process.env.T_U1);
      store.flush();
      await new Promise(r => setTimeout(r, 800));
      console.log('RESULT ' + JSON.stringify({ ok: true }));
      process.exit(0);
    })();
  `);
  const after = runScenario(`
    const store = require(${STORE});
    (async () => {
      await store.ready;
      console.log('RESULT ' + JSON.stringify({
        balance: store.getBalance(process.env.T_U1),
        invited: store.getReferralInfo(process.env.T_U1).level1,
        found: (store.getLeaderboard('week', 500).allRanked || []).some(r => r.userId === process.env.T_U2),
      }));
      process.exit(0);
    })();
  `);
  check('balance survived restart', after.balance === 500, JSON.stringify(after.balance));
  check('referral survived restart', after.invited === 1);
  check('leaderboard survived restart', after.found === true);

  console.log('\n2) storage outage => degraded mode, writes blocked (no wipe)');
  const degraded = runScenario(`
    const store = require(${STORE});
    (async () => {
      await store.ready;
      store.creditBalance(process.env.T_U5, 1);
      store.flush();
      await new Promise(r => setTimeout(r, 500));
      const i = store.persistInfo();
      console.log('RESULT ' + JSON.stringify({ degraded: i.degraded, blocked: i.blockedSaves }));
      process.exit(0);
    })();
  `, { UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:1' });
  check('degraded mode entered', degraded.degraded === true);
  check('writes were blocked', degraded.blocked > 0);
  const stillThere = runScenario(`
    const store = require(${STORE});
    (async () => {
      await store.ready;
      console.log('RESULT ' + JSON.stringify({ balance: store.getBalance(process.env.T_U1) }));
      process.exit(0);
    })();
  `);
  check('data intact after outage', stillThere.balance === 500);

  console.log('\n3) two overlapping instances merge instead of overwriting');
  const merged = runScenario(`
    const store = require(${STORE});
    const ENDPOINT = process.env.UPSTASH_REDIS_REST_URL;
    const cmd = (c) => fetch(ENDPOINT, { method: 'POST', headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' }, body: JSON.stringify(c) }).then(r => r.json());
    (async () => {
      await store.ready;
      store.trackUser(process.env.T_U4, 'A1'); store.creditBalance(process.env.T_U4, 77);
      const other = JSON.parse(JSON.stringify(store.getSnapshot()));
      other.savedBy = 'other-instance'; other.savedAt = Date.now() + 1000;
      other.balances[process.env.T_U5] = 999; other.knownUsers.push(process.env.T_U5);
      other.allTimeBest[process.env.T_U5] = { name: 'B2', score: 55 };
      delete other.balances[process.env.T_U4];
      await cmd(['SET', 'test:store', JSON.stringify(other)]);
      await new Promise(r => setTimeout(r, 2200));
      store.creditBalance(process.env.T_U4, 0); store.flush();
      await new Promise(r => setTimeout(r, 1200));
      const raw = await cmd(['GET', 'test:store']);
      const final = JSON.parse(raw.result);
      console.log('RESULT ' + JSON.stringify({ a: final.balances[process.env.T_U4], b: final.balances[process.env.T_U5] }));
      process.exit(0);
    })();
  `, { CONFLICT_CHECK_MS: '2000' });
  check('own instance data kept', merged.a === 77, String(merged.a));
  check('other instance data kept', merged.b === 999, String(merged.b));

  console.log('\n4) backup + restore round-trip');
  const roundTrip = runScenario(`
    const store = require(${STORE});
    (async () => {
      await store.ready;
      const b = await store.createBackup('test');
      store.creditBalance(process.env.T_U1, -400);           // "accident"
      store.flush();
      await new Promise(r => setTimeout(r, 500));
      const broken = store.getBalance(process.env.T_U1);
      const r = await store.restoreBackup(b.key || b.id);
      console.log('RESULT ' + JSON.stringify({ broken, restored: store.getBalance(process.env.T_U1), ok: r.ok }));
      process.exit(0);
    })();
  `);
  check('restore returns ok', roundTrip.ok === true);
  check('balance restored to pre-accident value', roundTrip.restored > roundTrip.broken,
    roundTrip.broken + ' -> ' + roundTrip.restored);

  console.log('\\n5) live durability probe reports a real write+read round-trip');
  const durProbe = runScenario(`
    const store = require(${STORE});
    (async () => {
      await store.ready;
      const probe = await store.probeDurability();
      const info = store.persistInfo();
      console.log('RESULT ' + JSON.stringify({ probeOk: probe.ok, durable: info.durable,
        backend: probe.backend, ms: probe.ms, writeFailed: !!probe.error }));
      process.exit(0);
    })();
  `);
  check('probe reports ok against live redis', durProbe.probeOk === true, JSON.stringify(durProbe));
  check('probe targets redis backend', durProbe.backend === 'upstash-redis');
  check('persist flags it durable', durProbe.durable === true);
  check('probe did not error', durProbe.writeFailed !== true);

  console.log('\\n6) DATA_FILE sitting on a DIRECTORY is healed, and the mount fix is explained');
  // Railway mounts a volume AS a directory — if it is mounted at the data file
  // itself, every save dies with EISDIR. The store must move it aside and write
  // a real file instead, and tell the operator which setting to change.
  const DIRFILE = path.join(TMP, 'dirstore.json');
  fs.mkdirSync(DIRFILE);
  fs.writeFileSync(path.join(DIRFILE, 'old-payload.txt'), 'keep me');
  const healed = runScenario(`
    const fs = require('fs'), path = require('path'), store = require(${STORE});
    (async () => {
      await store.ready;
      store.trackUser(process.env.T_U1, 'Ann'); store.creditBalance(process.env.T_U1, 123);
      store.flush();
      await new Promise(r => setTimeout(r, 800));
      const i = store.persistInfo();
      const probe = await store.probeDurability();
      const moved = fs.readdirSync(path.dirname(process.env.T_DIRFILE))
        .filter(f => f.indexOf('dirstore.json.dir-') === 0);
      console.log('RESULT ' + JSON.stringify({
        moved, kept: moved.length ? fs.readFileSync(path.join(path.dirname(process.env.T_DIRFILE), moved[0], 'old-payload.txt'), 'utf8') : null,
        isFile: fs.statSync(process.env.T_DIRFILE).isFile(),
        isDir: i.dataFileIsDirectory, hint: i.dataFileHint, err: i.lastSaveError,
        probeOk: probe.ok, probeHint: probe.hint || null,
        mountHint: store._dataFileMountHint(),
        nothingToHeal: store._relocateDataFileAside() === null,
      }));
      process.exit(0);
    })();
  `, { UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '', T_DIRFILE: DIRFILE, DATA_FILE: DIRFILE });
  check('directory renamed aside at boot', Array.isArray(healed.moved) && healed.moved.length === 1, JSON.stringify(healed.moved));
  check('old directory contents preserved', healed.kept === 'keep me');
  check('real file written at DATA_FILE afterwards', healed.isFile === true);
  check('save no longer errors', healed.err == null, String(healed.err));
  check('dataFileIsDirectory cleared', healed.isDir === false);
  check('dataFileHint null while healthy', healed.hint === null);
  check('probe ok once the path is a file', healed.probeOk === true);
  check('relocate returns null when there is nothing to heal', healed.nothingToHeal === true);
  check('hint names the parent dir as Mount Path',
    String(healed.mountHint).indexOf('Mount Path to ' + TMP + ' (NOT ' + DIRFILE + ')') > 0);
  check('hint keeps DATA_FILE unchanged', String(healed.mountHint).indexOf('DATA_FILE=' + DIRFILE + ', then redeploy.') > 0);

  console.log('\\n7) an UNMOVABLE directory (real mount point) fails loudly with the fix');
  const LOCK = fs.mkdtempSync(path.join(os.tmpdir(), 'flap-lock-'));
  const LOCKFILE = path.join(LOCK, 'store.json');
  fs.mkdirSync(LOCKFILE);
  fs.chmodSync(LOCK, 0o555);        // the rename cannot happen — just like a mount point
  const locked = runScenario(`
    const store = require(${STORE});
    (async () => {
      await store.ready;
      const i = store.persistInfo();
      const probe = await store.probeDurability();
      console.log('RESULT ' + JSON.stringify({ isDir: i.dataFileIsDirectory, hint: i.dataFileHint,
        probeOk: probe.ok, probeHint: probe.hint || null, same: i.dataFileHint === (probe.hint || null) }));
      process.exit(0);
    })();
  `, { UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '', DATA_FILE: LOCKFILE });
  check('still reported as a directory', locked.isDir === true);
  check('probe fails (ok:false)', locked.probeOk === false);
  check('probe carries the mount hint', String(locked.probeHint).indexOf('Mount Path to ' + LOCK + ' (NOT ' + LOCKFILE + ')') > 0);
  check('persistInfo carries the same hint', locked.same === true);

  try { fs.chmodSync(LOCK, 0o755); fs.rmSync(LOCK, { recursive: true, force: true }); } catch (e) {}
  mock.kill();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  console.log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED'));
  process.exit(failures ? 1 : 0);
}, 800);
