/**
 * Automatic top-ups: a payment made with "PAY WITH CONNECTED WALLET" must be
 * verified on-chain and credited WITHOUT anybody approving it in admin.html.
 *
 * The test boots the REAL server (server.js) against a mock TON indexer and
 * drives it over HTTP with a real signed transaction BOC, so the whole path is
 * exercised: /api/deposit → readSignedTopup → verifyDepositClaim (sender +
 * amount + time + destination) → store.approveDeposit → /api/deposit-status.
 *
 * Run with:  npm run test:deposit
 */
'use strict';

const crypto = require('crypto');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { Address, beginCell, internal, external, storeMessage, storeMessageRelaxed } = require('@ton/core');

const ROOT = path.resolve(__dirname, '..');
const BOT = '123456:TEST_BOT_TOKEN_abcdef0123456789';
const ADMIN = 'test-admin-key-0123456789abcdef';

const WALLET = new Address(0, Buffer.alloc(32, 0x11));  // the player's wallet
const STRANGER = new Address(0, Buffer.alloc(32, 0x33)); // somebody else
const DEPOSIT = new Address(0, Buffer.alloc(32, 0x22));  // where the game gets paid
const ELSEWHERE = new Address(0, Buffer.alloc(32, 0x44));
// A request that is left pending keeps being re-checked for the whole window,
// so each scenario signs from its own wallet — otherwise an earlier scenario's
// still-pending request can (correctly!) claim a later scenario's transfer.
const WALLET_SHORT = new Address(0, Buffer.alloc(32, 0x55));
const WALLET_TWICE = new Address(0, Buffer.alloc(32, 0x66));
const NANO_04 = 400000000n; // 0.4 TON → $1.00 at the pinned $2.50 rate → 100 C

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

// ---- helpers -------------------------------------------------------------

function makeInitData(user) {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAE_deposit_test',
    user: JSON.stringify(user),
  };
  const dataCheckString = Object.keys(fields).sort().map((k) => k + '=' + fields[k]).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const qs = new URLSearchParams();
  for (const k of Object.keys(fields)) qs.append(k, fields[k]);
  qs.append('hash', hash);
  return qs.toString();
}

// A wallet-v4 style signed transaction: an external message to the wallet whose
// body carries the internal transfer the wallet will relay.
function signedBoc(fromAddr, toAddr, nano, seq) {
  const relaxed = internal({
    to: toAddr.toString(), value: nano, bounce: false,
    body: beginCell().storeUint(0, 32).endCell(),
  });
  const walletBody = beginCell()
    .storeUint(0, 32).storeUint(seq || Date.now(), 64).storeUint(3, 8)
    .storeRef(beginCell().store(storeMessageRelaxed(relaxed)))
    .endCell();
  const msg = { info: external({ to: fromAddr.toString() }).info, init: null, body: walletBody };
  return beginCell().store(storeMessage(msg)).endCell().toBoc().toString('base64');
}

// One toncenter-v2 shaped transaction on the deposit address's history.
function ledgerTx({ source, valueNano, hash }) {
  return {
    '@type': 'raw.transaction',
    address: { account_address: DEPOSIT.toRawString() },
    utime: Math.floor(Date.now() / 1000),
    transaction_id: { lt: String(1000 + Math.floor(Math.random() * 1000)), hash: crypto.randomBytes(32).toString('hex') },
    in_msg: {
      source: source ? source.toRawString() : '',
      destination: DEPOSIT.toRawString(),
      value: String(valueNano),
      hash: hash || crypto.randomBytes(32).toString('hex'),
    },
    out_msgs: [],
  };
}

async function main() {
  // ---- mock TON indexer -------------------------------------------------
  let ledger = [];
  const indexer = http.createServer((req, res) => {
    const url = req.url || '';
    if (url.indexOf('/getTransactions') === 0 || url.indexOf('/api/v2/getTransactions') === 0) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: ledger }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  });
  await new Promise((resolve) => indexer.listen(0, '127.0.0.1', resolve));
  const indexerPort = indexer.address().port;

  // ---- real server ------------------------------------------------------
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'grm-deposit-'));
  // Seed an (empty) snapshot at DATA_FILE. Without a file there the store also
  // reads its in-repo fallback copy (data/store.json), which on a dev machine
  // holds leftovers from earlier test runs — the assertions below need a store
  // that starts empty.
  fs.writeFileSync(path.join(scratch, 'store.json'), '{"savedAt":0}');
  const boot = `
    const express = require('express');
    const listen = express.application.listen;
    express.application.listen = function (...args) {
      const server = listen.apply(this, args);
      server.once('listening', () => process.send({ port: server.address().port }));
      return server;
    };
    require('./server.js');
  `;
  const child = spawn(process.execPath, ['-e', boot], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: '0',
      NODE_ENV: 'test',
      ALLOW_INSECURE_DEV: 'false',
      DATA_FILE: path.join(scratch, 'store.json'),
      BACKUP_DIR: path.join(scratch, 'backups'),
      UPSTASH_REDIS_REST_URL: '',
      UPSTASH_REDIS_REST_TOKEN: '',
      BOT_TOKEN: BOT,
      ADMIN_KEY: ADMIN,
      SESSION_SECRET: 'deposit-test-only-session-secret',
      REQUIRE_DURABLE_STORAGE: 'false',
      // The automatic credit path under test.
      DEPOSIT_AUTO_CREDIT: 'true',
      DEPOSIT_AUTO_CREDIT_DELAYS_MS: '50,150,400',
      DEPOSIT_AUTO_CREDIT_SWEEP_MS: '5000',
      DEPOSIT_AUTO_CREDIT_WINDOW_MS: '30000',
      DEPOSIT_TON_ADDRESS: DEPOSIT.toString(),
      TON_RPC_URL: 'http://127.0.0.1:' + indexerPort + '/api/v2',
      TON_USD_PRICE: '2.5',
      MIN_DEPOSIT_NANO_TON: '10000000',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let logs = '';
  child.stdout.on('data', (d) => { logs = (logs + d).slice(-12000); });
  child.stderr.on('data', (d) => { logs = (logs + d).slice(-12000); });

  const base = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server startup timed out\n' + logs)), 15000);
    child.once('message', (m) => { clearTimeout(timeout); resolve('http://127.0.0.1:' + m.port); });
    child.once('error', (e) => { clearTimeout(timeout); reject(e); });
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error('server exited: ' + code + '\n' + logs)); });
  });
  console.log('  server up at ' + base + ', mock indexer on :' + indexerPort);

  const post = async (url, body, headers) => {
    const res = await fetch(base + url, {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
      body: JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch (e) { /* non-JSON */ }
    return { status: res.status, body: json };
  };

  // Poll like the mini app does after a wallet payment.
  async function waitStatus(initData, requestId, want, tries) {
    let last = null;
    for (let i = 0; i < (tries || 40); i++) {
      const r = await post('/api/deposit-status', { initData, requestId });
      last = r.body;
      if (r.body && r.body.status === want) return r.body;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return last;
  }

  try {
    // ---- 1) connected-wallet payment is credited by itself ---------------
    console.log('\n1) PAY WITH CONNECTED WALLET — automatic credit');
    ledger = [ledgerTx({ source: WALLET, valueNano: NANO_04 })];
    const userA = { id: 555000001, first_name: 'Auto', username: 'auto_payer' };
    const initDataA = makeInitData(userA);
    const a = await post('/api/deposit', {
      initData: initDataA, amount: 100,
      boc: signedBoc(WALLET, DEPOSIT, NANO_04), sender: '',
    });
    check('top-up accepted and flagged automatic', a.status === 200 && a.body && a.body.ok && a.body.auto === true, JSON.stringify(a.body));
    const stA = await waitStatus(initDataA, a.body.requestId, 'approved', 60);
    check('credited without any admin action', !!stA && stA.status === 'approved', JSON.stringify(stA));
    check('the paid amount landed on the account (100 C)', !!stA && Number(stA.cBalance) === 100, 'cBalance=' + (stA && stA.cBalance));
    check('auto-credit log line printed', logs.indexOf('credited 100 C') >= 0);

    const admin = await fetch(base + '/internal/deposits', { headers: { 'x-admin-key': ADMIN } });
    const list = (await admin.json()).deposits || [];
    const row = list.find((d) => d.id === a.body.requestId);
    check('admin sees it auto-approved via the signed transfer', !!row && row.autoApproved === true && row.verifiedBy === 'transfer',
      JSON.stringify(row && { autoApproved: row.autoApproved, verifiedBy: row.verifiedBy, wallet: row.wallet, expectedNano: row.expectedNano }));
    check('the signer was read out of the BOC, not typed by the client',
      !!row && String(row.wallet) === WALLET.toString(), 'wallet=' + (row && row.wallet));
    check('the paid request is not sitting in the manual queue',
      list.filter((d) => d.id === a.body.requestId && d.status === 'pending').length === 0,
      'pending in store: ' + list.filter((d) => d.status === 'pending').length);

    // ---- 2) the same amount from another wallet is NOT credited ----------
    console.log('\n2) same amount, different sender — must stay pending');
    ledger = [ledgerTx({ source: STRANGER, valueNano: NANO_04 })];
    const userB = { id: 555000002, first_name: 'Fake', username: 'copy_cat' };
    const initDataB = makeInitData(userB);
    const b = await post('/api/deposit', {
      initData: initDataB, amount: 100,
      boc: signedBoc(WALLET, DEPOSIT, NANO_04), sender: WALLET.toString(),
    });
    check('request accepted', b.status === 200 && b.body && b.body.ok, JSON.stringify(b.body));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const stB = await post('/api/deposit-status', { initData: initDataB, requestId: b.body.requestId });
    check('still pending — nobody else\'s transfer can pay for it', stB.body && stB.body.status === 'pending', JSON.stringify(stB.body));
    check('balance untouched', stB.body && Number(stB.body.cBalance) === 0, 'cBalance=' + (stB.body && stB.body.cBalance));

    // ---- 3) the same wallet paying less is NOT credited ------------------
    console.log('\n3) signed 0.4 TON, only 0.1 TON arrived — must stay pending');
    ledger = [ledgerTx({ source: WALLET_SHORT, valueNano: 100000000n })];
    const userC = { id: 555000003, first_name: 'Short', username: 'short_payer' };
    const initDataC = makeInitData(userC);
    const c = await post('/api/deposit', {
      initData: initDataC, amount: 100,
      boc: signedBoc(WALLET_SHORT, DEPOSIT, NANO_04), sender: WALLET_SHORT.toString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const stC = await post('/api/deposit-status', { initData: initDataC, requestId: c.body.requestId });
    check('a smaller transfer does not cover the claim', stC.body && stC.body.status === 'pending', JSON.stringify(stC.body));

    // ---- 4) a signed transaction aimed somewhere else is refused ---------
    console.log('\n4) signed BOC pays another address — refused');
    const userD = { id: 555000004, first_name: 'Wrong', username: 'wrong_target' };
    const d = await post('/api/deposit', {
      initData: makeInitData(userD), amount: 100,
      boc: signedBoc(WALLET, ELSEWHERE, NANO_04), sender: WALLET.toString(),
    });
    check('rejected at submission', d.status === 400, JSON.stringify(d.body));

    // ---- 5) a hand-pasted hash is still credited automatically -----------
    console.log('\n5) MANUAL TOP-UP — pasted hash is credited automatically');
    const pastedHash = crypto.randomBytes(32).toString('hex');
    ledger = [ledgerTx({ source: WALLET, valueNano: 200000000n, hash: pastedHash })];
    const userE = { id: 555000005, first_name: 'Manual', username: 'manual_payer' };
    const initDataE = makeInitData(userE);
    const e = await post('/api/deposit', { initData: initDataE, amount: 50, txHash: pastedHash });
    check('request accepted', e.status === 200 && e.body && e.body.ok, JSON.stringify(e.body));
    const stE = await waitStatus(initDataE, e.body.requestId, 'approved', 60);
    check('credited by hash match, no admin needed', !!stE && stE.status === 'approved', JSON.stringify(stE));
    check('the claimed 50 C was credited', !!stE && Number(stE.cBalance) === 50, 'cBalance=' + (stE && stE.cBalance));

    // ---- 6) one transfer cannot pay for two requests ---------------------
    console.log('\n6) two signed top-ups, only one real transfer — no double credit');
    ledger = [ledgerTx({ source: WALLET_TWICE, valueNano: NANO_04 })];
    const userG = { id: 555000007, first_name: 'Twice', username: 'double_spender' };
    const initDataG = makeInitData(userG);
    const g1 = await post('/api/deposit', {
      initData: initDataG, amount: 100,
      boc: signedBoc(WALLET_TWICE, DEPOSIT, NANO_04, 1001), sender: WALLET_TWICE.toString(),
    });
    const stG1 = await waitStatus(initDataG, g1.body.requestId, 'approved', 60);
    check('the first request is credited', !!stG1 && stG1.status === 'approved', JSON.stringify(stG1));
    const g2 = await post('/api/deposit', {
      initData: initDataG, amount: 100,
      boc: signedBoc(WALLET_TWICE, DEPOSIT, NANO_04, 1002), sender: WALLET_TWICE.toString(),
    });
    check('a second, differently signed request is accepted for checking', g2.status === 200 && g2.body && g2.body.ok, JSON.stringify(g2.body));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const stG2 = await post('/api/deposit-status', { initData: initDataG, requestId: g2.body.requestId });
    check('the same transfer cannot pay twice', stG2.body && stG2.body.status === 'pending', JSON.stringify(stG2.body));
    check('balance was not doubled', stG2.body && Number(stG2.body.cBalance) === 100, 'cBalance=' + (stG2.body && stG2.body.cBalance));
    const reuse = (await (await fetch(base + '/internal/deposits', { headers: { 'x-admin-key': ADMIN } })).json()).deposits
      .find((d) => d.id === g2.body.requestId);
    check('admin sees why it was refused', !!reuse && /already credited/.test(String(reuse.autoResult || '')), 'autoResult=' + (reuse && reuse.autoResult));

    // ---- 7) nothing on-chain → the request waits for a human -------------
    console.log('\n7) no matching transfer at all — stays in the manual queue');
    ledger = [];
    const userF = { id: 555000006, first_name: 'Ghost', username: 'ghost_payer' };
    const initDataF = makeInitData(userF);
    const f = await post('/api/deposit', {
      initData: initDataF, amount: 100,
      boc: signedBoc(WALLET, DEPOSIT, NANO_04), sender: WALLET.toString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const stF = await post('/api/deposit-status', { initData: initDataF, requestId: f.body.requestId });
    check('unpaid claim is never credited', stF.body && stF.body.status === 'pending', JSON.stringify(stF.body));
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 1500);
      child.kill('SIGTERM');
      await exited;
      clearTimeout(killTimer);
    }
    indexer.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('deposit test crashed:', err);
  process.exit(1);
});
