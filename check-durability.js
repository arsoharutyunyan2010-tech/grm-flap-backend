/**
 * check-durability.js — CLI durability self-check.
 *
 * Loads the store exactly as the server does, then performs a REAL write + read
 * probe against the active storage backend and prints the truth about whether
 * player data will survive your next deploy.
 *
 *   node check-durability.js          # uses .env / environment as-is
 *   node check-durability.js --json   # machine-readable output
 *
 * Exit code: 0 = durable & healthy, 1 = NOT safe (see the printed reason).
 */
require('dotenv').config();
const store = require('./store.js');

(async () => {
  await store.ready;
  const persist = store.persistInfo();
  const probe = await store.probeDurability();
  const ok = persist.degraded === false && probe.ok === true && probe.durable !== false;

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ok, persist, probe }, null, 2));
  } else {
    const green = (s) => s, red = (s) => s;
    console.log('\n=== GRM FLAP — data durability check ===\n');
    console.log('Backend        :', (probe.backend || persist.backend || 'unknown'));
    console.log('Configured     :', persist.durable ? 'durable (volume / redis)' : 'EPHEMERAL');
    if (probe.dataFile) console.log('Data file      :', probe.dataFile);
    console.log('Load state     :', persist.loadState);
    if (probe.ms != null) console.log('Probe latency  :', probe.ms + 'ms');
    console.log('');
    if (ok) {
      console.log(green('OK — player data is stored durably and survives redeploys.') + '\n');
    } else {
      console.log(red('!!! NOT SAFE — your player data may be wiped on the next deploy.') + '\n');
      if (persist.degraded) console.log(red('  Store is DEGRADED: ' + (persist.loadError || 'unknown')) + '\n');
      if (probe.error) console.log(red('  Probe error: ' + probe.error) + '\n');
      if (probe.hint) console.log(red('  ' + probe.hint) + '\n');
      if (probe.warning) console.log(red('  ' + probe.warning) + '\n');
      console.log('  Fix: set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN, or mount a\n' +
        '  persistent volume at /data and set DATA_FILE=/data/store.json.\n');
    }
  }
  process.exit(ok ? 0 : 1);
})();
