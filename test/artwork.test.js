'use strict';

// No browser or image-processing dependency is required for the regression
// suite. Exercise the actual inline UI functions in a small DOM harness, then
// check delivery through an isolated instance of the real Express server.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const names = [
  'mascot-crash', 'trophy-new-best', 'pvp-battle-banner',
  'pvp-searching', 'pvp-win', 'how-to-play', 'referral-friends',
];
const assetPath = name => path.join(ROOT, 'img', 'ui', name + '.webp');

function webpSize(buffer) {
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buffer.toString('ascii', 8, 12), 'WEBP');
  assert.equal(buffer.readUInt32LE(4) + 8, buffer.length);
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const chunk = buffer.toString('ascii', offset, offset + 4);
    const length = buffer.readUInt32LE(offset + 4);
    const data = offset + 8;
    assert.ok(data + length <= buffer.length, 'WebP chunk is not truncated');
    if (chunk === 'VP8X') return [buffer.readUIntLE(data + 4, 3) + 1, buffer.readUIntLE(data + 7, 3) + 1];
    if (chunk === 'VP8 ') return [buffer.readUInt16LE(data + 6) & 0x3fff, buffer.readUInt16LE(data + 8) & 0x3fff];
    if (chunk === 'VP8L') {
      const bits = buffer.readUInt32LE(data + 1);
      return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
    }
    offset = data + length + (length % 2);
  }
  assert.fail('No WebP dimensions found');
}

const attr = (tag, name) => (tag.match(new RegExp('\\b' + name + '="([^"]*)"')) || [])[1];

// These top-level declarations have two-space indentation; nested blocks do
// not. Fail explicitly if a refactor moves the functions, rather than testing
// a duplicated implementation or adding test-only globals to the live page.
function clientFunction(name) {
  const match = html.match(new RegExp('^  function ' + name + '\\([^]*?^  \\}', 'm'));
  assert.ok(match, 'Client function exists: ' + name);
  return match[0];
}

function element(hidden = false) {
  const classes = new Set(hidden ? ['hidden'] : []);
  return {
    style: {}, textContent: '', innerHTML: '',
    classList: {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name),
      toggle(name, force) {
        const enabled = force === undefined ? !classes.has(name) : force;
        if (enabled) classes.add(name); else classes.delete(name);
        return enabled;
      },
    },
  };
}

function clientHarness(overrides = {}) {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const saved = [];
  const context = vm.createContext({
    document: { getElementById: get },
    newBestBadge: get('newBestBadge'),
    finalScoreEl: get('finalScore'), finalBestEl: get('finalBest'),
    finalRankEl: get('finalRank'), verifyNote: get('verifyNote'),
    crashMode: get('crashMode'), finalMode: get('finalMode'), overCard: get('overCard'),
    state: 'crashed', pvpMode: false, accessLocked: false, DEMO_MODE: false,
    session: { sessionId: 'art-test-session' }, stepIndex: 100,
    score: 9, best: 5, flapLog: [], reviveLog: [], profileCache: null,
    saveBest: value => saved.push(value), refreshStatsAfterRun() {}, finalizePvpRun() {},
    submitScore: () => Promise.resolve({ verified: true, score: 9, allTimeBest: 9, newBest: true }),
    setAmt() {}, t: key => key, coinImg: () => '<coin>',
    stopPvpPoll() {}, stopPvpHeartbeat() {}, stopPvpConfirmTick() {},
    startPvpPoll() {}, startPvpHeartbeat() {}, setInterval: () => 1,
    pvpStake: 10,
    ...overrides,
  });
  for (const name of ['setFinalArtwork', 'finalizeRun', 'setPvpResultArtwork', 'hideGameOverlays', 'pvpScoreLine', 'applyPvpState']) {
    vm.runInContext(clientFunction(name), context);
  }
  return { context, get, saved };
}

const visible = el => !el.classList.contains('hidden');
const flushPromises = () => new Promise(resolve => setImmediate(resolve));

test('all seven illustrations are small, valid WebP files with lazy accessible markup', () => {
  assert.deepEqual(fs.readdirSync(path.join(ROOT, 'img', 'ui')).sort(), names.map(n => n + '.webp').sort());
  let totalBytes = 0;
  for (const name of names) {
    const buffer = fs.readFileSync(assetPath(name));
    const [width, height] = webpSize(buffer);
    totalBytes += buffer.length;
    assert.ok(buffer.length < 100 * 1024, name + ' fits its transfer budget');
    assert.ok(width <= 768 && height <= 400, name + ' is sized for mobile');
    const images = [...html.matchAll(/<img\b[^>]*>/g)].map(m => m[0])
      .filter(tag => attr(tag, 'src') === '/img/ui/' + name + '.webp');
    assert.ok(images.length, name + ' is integrated, not just checked in');
    for (const tag of images) {
      assert.equal(attr(tag, 'loading'), 'lazy');
      assert.equal(attr(tag, 'decoding'), 'async');
      assert.equal(attr(tag, 'alt'), '');
      assert.equal(attr(tag, 'aria-hidden'), 'true');
      assert.equal(Number(attr(tag, 'width')), width);
      assert.equal(Number(attr(tag, 'height')), height);
    }
    assert.ok(!html.includes('/img/' + name + '.png'), 'Full-size source is not downloaded: ' + name);
  }
  assert.ok(totalBytes < 500 * 1024, 'Entire new art pack stays below 500 KiB');
});

test('every inline script still compiles', () => {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const [index, match] of scripts.entries()) new vm.Script(match[1], { filename: 'index-inline-' + index });
});

test('classic result artwork and the translated badge switch and reset together', () => {
  const { context, get } = clientHarness();
  for (const newBest of [false, true, false]) {
    context.setFinalArtwork(newBest);
    assert.equal(visible(get('newBestArt')), newBest);
    assert.equal(visible(get('newBestBadge')), newBest);
  }
});

test('pending verification resets a previous trophy; only a verified record restores it', async () => {
  let resolve;
  const { context, get, saved } = clientHarness({ submitScore: () => new Promise(r => { resolve = r; }) });
  context.setFinalArtwork(true);
  context.finalizeRun();
  assert.equal(visible(get('newBestArt')), false);
  assert.equal(get('finalBest').textContent, 5);
  resolve({ verified: true, score: 9, allTimeBest: 9, newBest: true, ranks: { day: 3 } });
  await flushPromises();
  assert.equal(visible(get('newBestArt')), true);
  assert.equal(get('finalScore').textContent, 9);
  assert.equal(get('finalRank').textContent, '#3');
  assert.deepEqual(saved, [9]);
});

test('server record flag wins over stale local bests (including tied scores)', async () => {
  for (const response of [
    { verified: true, score: 9, allTimeBest: 9, newBest: false },
    { verified: true, score: 9, allTimeBest: 40, newBest: false },
    { verified: true, score: 9, allTimeBest: 40 }, // older backend, no newBest flag
  ]) {
    const { context, get } = clientHarness({ best: 0, submitScore: () => Promise.resolve(response) });
    context.finalizeRun();
    await flushPromises();
    assert.equal(visible(get('newBestArt')), false);
    }
  const { context, get } = clientHarness({ best: 50 });
  context.finalizeRun();
  await flushPromises();
  assert.equal(visible(get('newBestArt')), true, 'Server-confirmed record is authoritative');
});

test('rejected or offline live submissions never celebrate or save a best', async () => {
  const { context, get, saved } = clientHarness({
    score: 999,
    submitScore: () => Promise.resolve({ verified: false, error: 'submission rejected' }),
  });
  context.finalizeRun();
  await flushPromises();
  assert.equal(visible(get('newBestArt')), false);
  assert.equal(get('finalBest').textContent, 5);
  assert.deepEqual(saved, []);
});

test('explicit demo play still supports local records', async () => {
  const { context, get, saved } = clientHarness({
    DEMO_MODE: true, submitScore: () => Promise.resolve({ verified: false }),
  });
  context.finalizeRun();
  await flushPromises();
  assert.equal(visible(get('newBestArt')), true);
  assert.deepEqual(saved, [9]);
});

test('a delayed result cannot overwrite another flight or a game access lock', async () => {
  for (const change of [
    ctx => { ctx.session = { sessionId: 'next-flight' }; },
    ctx => { ctx.state = 'playing'; },
    ctx => { ctx.accessLocked = true; },
    ctx => { ctx.pvpMode = true; },
  ]) {
    let resolve;
    const { context, get, saved } = clientHarness({ submitScore: () => new Promise(r => { resolve = r; }) });
    context.finalizeRun();
    change(context);
    resolve({ verified: true, score: 9, allTimeBest: 9, newBest: true });
    await flushPromises();
    assert.equal(visible(get('newBestArt')), false);
    assert.deepEqual(saved, []);
  }
});

test('PvP server results select win, loss and draw art without stale victories', () => {
  const { context, get } = clientHarness();
  const match = { status: 'done', youAre: 'p1', p1: { name: 'One', score: 9 }, p2: { name: 'Two', score: 6 }, winnerPrize: 18 };
  for (const [winner, art, title, credit] of [
    ['p1', 'pvpWinArt', 'pvpYouWin', true],
    ['p2', 'pvpLoseArt', 'pvpYouLose', false],
    ['tie', 'pvpDrawArt', 'pvpDraw', true],
    ['p1', 'pvpWinArt', 'pvpYouWin', true],
  ]) {
    context.applyPvpState({ match: { ...match, winner } });
    for (const id of ['pvpWinArt', 'pvpLoseArt', 'pvpDrawArt']) assert.equal(visible(get(id)), id === art);
    assert.equal(get('pvpResultTitle').textContent, title);
    assert.equal(visible(get('pvpResultCard')), true);
    assert.equal(visible(get('pvpResultCredit')), credit);
  }
  context.applyPvpState({ waiting: true, stake: 20 });
  assert.equal(visible(get('pvpResultCard')), false);
  assert.equal(visible(get('pvpWaitCard')), true);
  assert.ok(get('pvpWaitHint').innerHTML.includes('20'));
});

test('failed artwork is hidden independently of result visibility and native labels', () => {
  const failed = element();
  const pending = element();
  const events = {};
  Object.assign(failed, { complete: true, naturalWidth: 0, addEventListener() {} });
  Object.assign(pending, { complete: false, naturalWidth: 0, addEventListener: (name, cb) => { events[name] = cb; } });
  const start = html.indexOf("  document.querySelectorAll('img.screen-art').forEach");
  assert.ok(start >= 0);
  const end = html.indexOf('\n  });', start) + '\n  });'.length;
  vm.runInNewContext(html.slice(start, end), { document: { querySelectorAll: () => [failed, pending] } });
  assert.equal(failed.classList.contains('art-unavailable'), true);
  assert.equal(pending.classList.contains('art-unavailable'), false);
  events.error();
  assert.equal(pending.classList.contains('art-unavailable'), true);
  pending.classList.toggle('hidden', false);
  assert.equal(pending.classList.contains('art-unavailable'), true, 'Changing outcomes cannot redisplay a broken image');
  assert.match(html, /\.screen-art\.art-unavailable\s*\{\s*display:\s*none\s*!important/);
});

test('submit-score reports records from the verified score and stored account best', () => {
  const start = serverSource.indexOf("app.post('/api/submit-score',");
  assert.ok(start >= 0);
  const route = serverSource.slice(start, serverSource.indexOf('\n});', start) + '\n});'.length);
  for (const score of [3, 8, 9]) {
    let handler, response;
    let best = 8;
    vm.runInNewContext(route, {
      app: { post: (url, fn) => { handler = fn; } },
      authenticate: () => ({ id: 'art-test' }), rejectBanned: () => false,
      replaySession: () => ({ ok: true, session: { userId: 'art-test', name: 'Test' }, replay: { score, revivesUsed: 0 } }),
      displayName: () => 'Test', ranksFor: () => ({ day: 1, week: 1, month: 1 }),
      store: {
        allowRequest: () => true, newAccountGate: () => ({ ok: true }), checkScoreAnomaly: () => [],
        getAllTimeBest: () => best, updateAllTimeBest: (id, name, value) => (best = Math.max(best, value)),
        submitPeriodScores() {}, recordVerifiedRun() {}, activateReferral() {}, recordRun() {},
        currentWeekKey: () => '', currentDayKey: () => '', currentMonthKey: () => '', getBalance: () => 0,
      },
    });
    handler({ body: { clientScore: 999999 } }, { json: value => { response = value; } });
    assert.equal(response.newBest, score > 8);
    assert.equal(response.score, score);
    assert.equal(response.allTimeBest, Math.max(8, score));
    assert.equal(response.clientScoreMismatch, true);
  }
});

test('real server serves every derivative as WebP without exposing source or test code', { timeout: 20000 }, async t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'grm-artwork-'));
  // Capture the OS-selected port, not a hard-coded port that can conflict with
  // another test. The store and backups never touch the developer's data.
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
      ...process.env, PORT: '0', NODE_ENV: 'test', ALLOW_INSECURE_DEV: 'false',
      DATA_FILE: path.join(scratch, 'store.json'), BACKUP_DIR: path.join(scratch, 'backups'),
      UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '',
      BOT_TOKEN: '', ADMIN_KEY: '', SESSION_SECRET: 'artwork-test-only-session-secret',
      DEPOSIT_AUTO_CREDIT: 'false', REQUIRE_DURABLE_STORAGE: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let logs = '';
  child.stdout.on('data', data => { logs = (logs + data).slice(-8000); });
  child.stderr.on('data', data => { logs = (logs + data).slice(-8000); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 1500);
      child.kill('SIGTERM');
      await exited;
      clearTimeout(killTimer);
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Artwork server startup timed out\n' + logs)), 10000);
    child.once('message', message => { clearTimeout(timeout); resolve(message.port); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error('Artwork server exited: ' + code + '\n' + logs)); });
  });
  const base = 'http://127.0.0.1:' + port;
  for (const name of names) {
    const expected = fs.readFileSync(assetPath(name));
    const response = await fetch(base + '/img/ui/' + name + '.webp');
    assert.equal(response.status, 200, name);
    assert.match(response.headers.get('content-type'), /^image\/webp/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
  }
  for (const blocked of ['/scripts/prepare-ui-art.py', '/test/artwork.test.js', '/server.js', '/art-assets.js']) {
    assert.equal((await fetch(base + blocked)).status, 404, blocked + ' is not public');
  }
});
