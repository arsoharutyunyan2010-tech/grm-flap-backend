/**
 * Wallet-connect tests — run with:  npm run test:wallet
 *
 * Covers the Wallet page "CONNECT WALLET" feature end to end:
 *   1. TON address parsing / user-friendly encoding (CRC16 tamper checks)
 *   2. ton_proof signature verification (valid + every tamper vector)
 *   3. store.js persistence of connections across a process restart
 *   4. the HTTP API: manifest, challenge, connect (TON + Telegram Wallet),
 *      disconnect, admin listing and withdrawal provenance checks
 */
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TW = require('../tonwallet.js');
const PORT = 7998;
const BASE = 'http://127.0.0.1:' + PORT;
const ADMIN_KEY = 'test-admin-key-long-enough-1234';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flap-wallet-'));
const DATA_FILE = path.join(TMP, 'store.json');
const RUN = 't' + Date.now();
let failures = 0;

function check(name, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest(); }

function makeProof(parsed, privateKey, domain, payload, tsOverride) {
  const ts = tsOverride == null ? Math.floor(Date.now() / 1000) : tsOverride;
  const wc = Buffer.alloc(4); wc.writeInt32BE(parsed.workchain, 0);
  const dl = Buffer.alloc(4); dl.writeUInt32LE(Buffer.byteLength(domain, 'utf8'), 0);
  const tsb = Buffer.alloc(8); tsb.writeBigUInt64LE(BigInt(ts), 0);
  const message = Buffer.concat([
    Buffer.from('ton-proof-item-v2/', 'utf8'),
    wc,
    Buffer.from(parsed.hashHex, 'hex'),
    dl,
    Buffer.from(domain, 'utf8'),
    tsb,
    Buffer.from(payload, 'utf8'),
  ]);
  const digest = sha256(Buffer.concat([Buffer.from([0xff, 0xff]), Buffer.from('ton-connect', 'utf8'), sha256(message)]));
  return {
    timestamp: ts,
    domain: { lengthBytes: Buffer.byteLength(domain, 'utf8'), value: domain },
    payload,
    signature: crypto.sign(null, digest, privateKey).toString('base64'),
  };
}

function rawPubHex(keyPair) {
  return keyPair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
}

// --- 1. addresses ----------------------------------------------------------
(function addresses() {
  const hashHex = crypto.randomBytes(32).toString('hex');
  const raw = '0:' + hashHex;
  const p = TW.parseTonAddress(raw);
  check('parse raw address', !!p && p.raw === raw);
  const friendly = TW.toFriendly(p.workchain, p.hashHex, { bounceable: false });
  const back = TW.parseTonAddress(friendly);
  check('friendly round-trip', !!back && back.raw === raw && friendly.length === 48);
  const bounceable = TW.toFriendly(p.workchain, p.hashHex, { bounceable: true });
  check('bounceable parse', !!TW.parseTonAddress(bounceable));
  // flip one CRC byte -> must be rejected
  const bytes = Buffer.from(friendly.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  bytes[35] ^= 0xff;
  const broken = bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  check('corrupted CRC rejected', TW.parseTonAddress(broken) === null);
  check('junk rejected', TW.parseTonAddress('not-an-address') === null && TW.parseTonAddress('') === null);
  const master = TW.parseTonAddress('-1:' + hashHex);
  check('masterchain parsed', !!master && master.workchain === -1);
  check('handles normalized', TW.normalizeTelegramHandle('@Arso_1') === '@arso_1' && TW.normalizeTelegramHandle('x') === '');
})();

// --- 2. ton_proof ----------------------------------------------------------
(function proofs() {
  const hashHex = crypto.randomBytes(32).toString('hex');
  const parsed = TW.parseTonAddress('0:' + hashHex);
  const kp = crypto.generateKeyPairSync('ed25519');
  const domain = 'example.app';
  const payload = 'challenge-' + crypto.randomBytes(8).toString('hex');
  const proof = makeProof(parsed, kp.privateKey, domain, payload);
  check('valid proof verifies', TW.verifyTonProof(proof, parsed, rawPubHex(kp), domain, payload, 600).ok === true);

  const other = crypto.generateKeyPairSync('ed25519');
  check('foreign key rejected', TW.verifyTonProof(proof, parsed, rawPubHex(other), domain, payload, 600).ok === false);
  check('wrong payload rejected', TW.verifyTonProof(proof, parsed, rawPubHex(kp), domain, payload + 'x', 600).ok === false);
  check('wrong domain rejected', TW.verifyTonProof(proof, parsed, rawPubHex(kp), 'evil.app', payload, 600).ok === false);
  check('stale proof rejected', TW.verifyTonProof(makeProof(parsed, kp.privateKey, domain, payload, Math.floor(Date.now() / 1000) - 3600), parsed, rawPubHex(kp), domain, payload, 600).ok === false);

  const mutated = JSON.parse(JSON.stringify(proof));
  mutated.signature = Buffer.from(Buffer.from(mutated.signature, 'base64').map((b, i) => i === 0 ? b ^ 1 : b)).toString('base64');
  check('mutated signature rejected', TW.verifyTonProof(mutated, parsed, rawPubHex(kp), domain, payload, 600).ok === false);

  const otherAddr = TW.parseTonAddress('0:' + crypto.randomBytes(32).toString('hex'));
  check('proof bound to address', TW.verifyTonProof(proof, otherAddr, rawPubHex(kp), domain, payload, 600).ok === false);
})();

// --- 3. store persistence across restart -----------------------------------
(function storeRoundTrip() {
  const childCode = `
    const store = require(${JSON.stringify(path.join(__dirname, '..', 'store.js'))});
    const rec = store.saveWallet('${RUN}u1', { provider: 'tonkeeper', addressRaw: '0:${'a'.repeat(64)}', addressFriendly: 'X', publicKey: 'f'.repeat(64), proofVerified: true });
    store.saveWallet('${RUN}u1', { provider: 'telegram', handle: '@someone' });
    store.flush();
    setTimeout(() => console.log('RESULT ' + JSON.stringify({
      ok: !!rec, wallets: store.listWallets('${RUN}u1').map(w => w.provider).sort(),
    })), 300);
  `;
  const first = spawnSync(process.execPath, ['-e', childCode], {
    env: Object.assign({}, process.env, { DATA_FILE, UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '' }),
    encoding: 'utf8', timeout: 60000,
  });
  const out1 = (first.stdout || '') + (first.stderr || '');
  const r1 = (out1.match(/RESULT (.*)/) || [])[1];
  check('store saves wallets', !!r1 && JSON.parse(r1).ok === true, r1 || out1.slice(0, 200));

  const readCode = `
    const store = require(${JSON.stringify(path.join(__dirname, '..', 'store.js'))});
    setTimeout(() => console.log('RESULT ' + JSON.stringify({
      providers: store.listWallets('${RUN}u1').map(w => w.provider).sort(),
      verified: (store.getWallet('${RUN}u1', 'tonkeeper') || {}).proofVerified === true,
      handle: (store.getWallet('${RUN}u1', 'telegram') || {}).handle || '',
      all: store.listAllWallets(10).length,
    })), 600);
  `;
  const second = spawnSync(process.execPath, ['-e', readCode], {
    env: Object.assign({}, process.env, { DATA_FILE, UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '' }),
    encoding: 'utf8', timeout: 60000,
  });
  const out2 = (second.stdout || '') + (second.stderr || '');
  const r2raw = (out2.match(/RESULT (.*)/) || [])[1];
  if (!r2raw) { check('store reloads wallets', false, out2.slice(0, 300)); return; }
  const r2 = JSON.parse(r2raw);
  check('wallets survive restart', JSON.stringify(r2.providers) === JSON.stringify(['telegram', 'tonkeeper']), JSON.stringify(r2));
  check('proofVerified persisted', r2.verified === true);
  check('telegram handle persisted', r2.handle === '@someone');
  check('admin listing works', r2.all >= 2);
})();

// --- 4. HTTP API -----------------------------------------------------------
async function httpTests() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      ALLOW_INSECURE_DEV: 'true',
      BOT_TOKEN: '',
      ADMIN_KEY,
      DATA_FILE,
      UPSTASH_REDIS_REST_URL: '',
      UPSTASH_REDIS_REST_TOKEN: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 20000);
    const onData = (chunk) => { if (/listening on/.test(String(chunk))) { clearTimeout(timer); resolve(); } };
    server.stdout.on('data', onData);
    server.stderr.on('data', onData);
    server.on('exit', (code) => reject(new Error('server exited ' + code)));
  });

  try {
    const post = async (p, body) => {
      const res = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      let json = null;
      try { json = await res.json(); } catch (e) {}
      return { status: res.status, json };
    };

    // manifest + icon
    const man = await fetch(BASE + '/tonconnect-manifest.json');
    const manJson = await man.json();
    check('manifest served', man.status === 200 && !!manJson.url && !!manJson.iconUrl && manJson.iconUrl.indexOf('/tonconnect-icon.png') > 0, JSON.stringify(manJson));
    const icon = await fetch(BASE + '/tonconnect-icon.png');
    check('icon served', icon.status === 200 && icon.headers.get('content-type') === 'image/png');

    // challenge + telegram wallet connect
    const ch = await post('/api/wallet/challenge', {});
    check('challenge issued', ch.status === 200 && !!ch.json.payload && !!ch.json.manifestUrl);

    const tg = await post('/api/wallet/connect', { provider: 'telegram', handle: '@payout_guy' });
    check('telegram wallet saved', tg.status === 200 && tg.json.ok === true && (tg.json.wallets || []).some(w => w.provider === 'telegram' && w.handle === '@payout_guy'));
    const tgBad = await post('/api/wallet/connect', { provider: 'telegram', handle: 'a' });
    check('bad handle rejected', tgBad.status === 400);

    // TON connect with a real signed proof
    const hashHex = crypto.randomBytes(32).toString('hex');
    const parsed = TW.parseTonAddress('0:' + hashHex);
    const kp = crypto.generateKeyPairSync('ed25519');
    const domain = '127.0.0.1:' + PORT; // what the server derives from the request host
    const ch2 = await post('/api/wallet/challenge', {});
    const payload = ch2.json.payload;
    const proof = makeProof(parsed, kp.privateKey, domain, payload);
    const conn = await post('/api/wallet/connect', {
      provider: 'tonkeeper',
      address: parsed.raw,
      publicKey: rawPubHex(kp),
      chain: '-239',
      label: 'tonkeeper',
      proof,
      payload,
    });
    check('ton connect accepted', conn.status === 200 && conn.json.ok === true);
    check('proof verified true', conn.json.proofVerified === true, JSON.stringify(conn.json.wallet || {}));
    const savedTon = (conn.json.wallets || []).find(w => w.provider === 'tonkeeper');
    check('friendly address stored', !!savedTon && savedTon.addressFriendly.length === 48);

    // tampered proof must not be verified
    const ch3 = await post('/api/wallet/challenge', {});
    const badProof = makeProof(parsed, kp.privateKey, domain, ch3.json.payload);
    badProof.payload = ch3.json.payload + 'zz';
    const connBad = await post('/api/wallet/connect', {
      provider: 'mytonwallet', address: parsed.raw, publicKey: rawPubHex(kp), chain: '-239',
      proof: badProof, payload: ch3.json.payload,
    });
    check('tampered proof flagged', connBad.status === 200 && connBad.json.proofVerified === false);

    // replay of a consumed challenge must fail verification
    const ch4 = await post('/api/wallet/challenge', {});
    await post('/api/wallet/challenge', {}); // overwrites the pending challenge
    const proof4 = makeProof(parsed, kp.privateKey, domain, ch4.json.payload);
    const conn4 = await post('/api/wallet/connect', { provider: 'tonkeeper', address: parsed.raw, publicKey: rawPubHex(kp), chain: '-239', proof: proof4, payload: ch4.json.payload });
    check('stale challenge rejected', conn4.json.proofVerified === false);

    // withdrawals: provider routing
    const wdNoWallet = await post('/api/withdraw', { provider: 'telegram', address: '@not_saved', amount: 10 });
    check('withdraw without wallet blocked', wdNoWallet.status === 400);
    const wd = await post('/api/withdraw', { provider: 'telegram', address: '@payout_guy', amount: 10 });
    check('withdraw needs balance', wd.status === 400 && /insufficient/.test(wd.json.error || ''));
    const wdTon = await post('/api/withdraw', { provider: 'tonkeeper', address: parsed.raw, amount: 10 });
    check('ton withdraw routed', wdTon.status === 400 && /insufficient/.test(wdTon.json.error || ''));
    const foreignRaw = '0:' + crypto.randomBytes(32).toString('hex');
    const wdWrongWallet = await post('/api/withdraw', { provider: 'mytonwallet', address: foreignRaw, amount: 10 });
    check('unconnected wallet withdraw blocked', wdWrongWallet.status === 400 && /not connected/.test(wdWrongWallet.json.error || ''));

    // profile + admin
    const prof = await post('/api/profile', {});
    check('profile lists wallets', prof.status === 200 && (prof.json.wallets || []).length >= 2);
    const adminNoKey = await fetch(BASE + '/internal/wallets');
    check('admin route needs key', adminNoKey.status === 403);
    const admin = await fetch(BASE + '/internal/wallets', { headers: { 'x-admin-key': ADMIN_KEY } });
    const adminJson = await admin.json();
    check('admin sees wallets', admin.status === 200 && (adminJson.wallets || []).some(w => w.userId === 'dev-user' && w.provider === 'tonkeeper'));

    // disconnect
    const disc = await post('/api/wallet/disconnect', { provider: 'telegram' });
    check('disconnect works', disc.status === 200 && !(disc.json.wallets || []).some(w => w.provider === 'telegram'));
  } finally {
    server.kill('SIGTERM');
  }
}

httpTests()
  .catch((err) => { check('http suite ran', false, String(err && err.message)); })
  .then(() => {
    console.log(failures ? '\nWALLET TESTS FAILED: ' + failures : '\nALL WALLET TESTS PASSED');
    process.exit(failures ? 1 : 0);
  });
