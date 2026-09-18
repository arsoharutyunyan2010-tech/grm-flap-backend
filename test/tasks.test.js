/**
 * Tests for the TASKS ("ЗАДАНИЯ") subscription feature:
 *   1. /api/tasks lists the configured channel + chat tasks with t.me links.
 *   2. /api/tasks/check verifies membership through the Telegram Bot API
 *      (getChatMember is mocked) before marking a task done.
 *   3. The FLAP reward is credited exactly once — re-checking is idempotent.
 *   4. A "not a member" answer never marks the task done.
 *   5. A Telegram failure (bad response) answers 503 and never marks done.
 *   6. Unknown task ids are rejected.
 *   7. Completion survives a snapshot round-trip (persistence).
 *
 * Run with:  npm run test:tasks
 */
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

// Isolate the store so the test never touches a real data file. Everything
// must be set BEFORE the first require of store.js/server.js.
const TMP = path.join(os.tmpdir(), 'grmflap-tasks-' + process.pid + '.json');
process.env.DATA_FILE = TMP;
process.env.BACKUP_DIR = TMP + '.backups';
process.env.UPSTASH_REDIS_REST_URL = '';
process.env.PORT = '4783';
process.env.NODE_ENV = '';
process.env.BOT_TOKEN = '12345:TEST-TOKEN';
process.env.TASKS_CHANNEL = '@TestChan';
process.env.TASKS_CHAT = '-1009999990100'; // private chat: verified by numeric id
process.env.TASKS_CHAT_URL = 'https://t.me/+InviteHash';  // what players open
process.env.TASKS_REWARD_FLAP = '1';

const store = require('../store.js');

// --- mock Telegram Bot API --------------------------------------------------
// membership: true = member, false = left, 'error' = telegram answers !ok
const membership = new Map();
const lastChatId = { value: '' };
global.fetch = async function (url, opts) {
  if (String(url).indexOf('api.telegram.org') === -1) throw new Error('unexpected fetch ' + url);
  const body = JSON.parse(opts.body);
  lastChatId.value = String(body.chat_id);
  const key = body.chat_id + ':' + body.user_id;
  const state = membership.has(key) ? membership.get(key) : false;
  if (state === 'error') {
    return { ok: true, status: 200, json: async () => ({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }) };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result: { status: state ? 'member' : 'left', user: { id: body.user_id } } }),
  };
};

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}

// --- signed initData helper (same scheme as telegramAuth.js) ----------------
function signInitData(user) {
  const params = new URLSearchParams();
  params.set('auth_date', String(Math.floor(Date.now() / 1000)));
  params.set('query_id', 'AAF' + crypto.randomBytes(6).toString('hex'));
  params.set('user', JSON.stringify(user));
  const pairs = [];
  for (const [key, value] of params.entries()) pairs.push(`${key}=${value}`);
  pairs.sort();
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(pairs.join('\n')).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

function postJson(port, p, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body || {});
    const req = http.request(
      { host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 5000 },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let out = null;
          try { out = JSON.parse(raw); } catch (e) { out = { parseError: true, raw: raw.slice(0, 120) }; }
          out.status = res.statusCode;
          resolve(out);
        });
      }
    );
    req.on('error', (err) => resolve({ err: String(err.message || err), status: 0 }));
    req.write(data);
    req.end();
  });
}

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

store.ready.then(async () => {
  require('../server.js');
  await waitServer(4783, 8000);

  const alice = { id: 900101, first_name: 'Alice', username: 'alice_test' };
  const bob = { id: 900102, first_name: 'Bob', username: 'bob_test' };
  const carol = { id: 900103, first_name: 'Carol', username: 'carol_test' };
  const aliceAuth = signInitData(alice);
  const bobAuth = signInitData(bob);
  const carolAuth = signInitData(carol);

  console.log('\n1) /api/tasks lists channel + chat tasks');
  membership.set('@TestChan:' + alice.id, false);
  membership.set('-1009999990100:' + alice.id, false);
  const list = await postJson(4783, '/api/tasks', { initData: aliceAuth });
  check('answers 200 with two tasks', list.status === 200 && Array.isArray(list.tasks) && list.tasks.length === 2, JSON.stringify(list));
  check('channel task points at t.me/TestChan', list.tasks[0] && list.tasks[0].url === 'https://t.me/TestChan' && list.tasks[0].kind === 'channel', JSON.stringify(list.tasks[0]));
  check('chat task opens the private invite link', list.tasks[1] && list.tasks[1].url === 'https://t.me/+InviteHash' && list.tasks[1].kind === 'chat', JSON.stringify(list.tasks[1]));
  check('tasks start not done with the configured reward', list.tasks.every((t) => t.done === false && t.reward === 1));
  // membership stays false here — these calls only prove WHICH chat_id the
  // server sends to the Telegram API (no side effects, done:false).
  await postJson(4783, '/api/tasks/check', { initData: aliceAuth, taskId: 'join_channel' });
  check('username is sent with @ to the Telegram API', lastChatId.value === '@TestChan', 'chat_id=' + lastChatId.value);
  await postJson(4783, '/api/tasks/check', { initData: aliceAuth, taskId: 'join_chat' });
  check('private chat is verified by its numeric id', lastChatId.value === '-1009999990100', 'chat_id=' + lastChatId.value);

  console.log('\n2) check refuses a non-member');
  membership.set('@TestChan:' + bob.id, false);
  const nope2 = await postJson(4783, '/api/tasks/check', { initData: bobAuth, taskId: 'join_channel' });
  check('not-a-member answers done:false', nope2.status === 200 && nope2.done === false, JSON.stringify(nope2));
  const bobList = await postJson(4783, '/api/tasks', { initData: bobAuth });
  check('task still not done for Bob', bobList.tasks.every((t) => t.done === false));
  check('Bob earned nothing', bobList.balance === 0, 'balance=' + bobList.balance);

  console.log('\n3) member gets marked done + rewarded exactly once');
  membership.set('@TestChan:' + alice.id, true);
  const ok1 = await postJson(4783, '/api/tasks/check', { initData: aliceAuth, taskId: 'join_channel' });
  check('member check answers done:true', ok1.status === 200 && ok1.done === true, JSON.stringify(ok1));
  check('reward credited once', ok1.reward === 1 && ok1.balance === 1, JSON.stringify(ok1));
  const again = await postJson(4783, '/api/tasks/check', { initData: aliceAuth, taskId: 'join_channel' });
  check('re-check is idempotent (already done, no double reward)', again.done === true && again.already === true && again.reward === 0 && again.balance === 1, JSON.stringify(again));
  membership.set('-1009999990100:' + alice.id, true);
  const ok2 = await postJson(4783, '/api/tasks/check', { initData: aliceAuth, taskId: 'join_chat' });
  check('second task pays separately', ok2.done === true && ok2.balance === 2, JSON.stringify(ok2));
  const aliceList = await postJson(4783, '/api/tasks', { initData: aliceAuth });
  check('both tasks now done for Alice', aliceList.tasks.every((t) => t.done === true), JSON.stringify(aliceList.tasks));
  check('admin sees soft "task done" events', store.listAntiCheatEvents(50).filter((e) => e.reason === 'task done').length >= 2);

  console.log('\n4) Telegram failure -> 503, task stays open');
  membership.set('@TestChan:' + carol.id, 'error');
  const errRes = await postJson(4783, '/api/tasks/check', { initData: carolAuth, taskId: 'join_channel' });
  check('unavailable verification answers 503', errRes.status === 503, JSON.stringify(errRes));
  const carolList = await postJson(4783, '/api/tasks', { initData: carolAuth });
  check('task NOT marked done on Telegram failure', carolList.tasks.every((t) => t.done === false));
  check('Carol earned nothing', carolList.balance === 0);

  console.log('\n5) bad requests');
  const unknown = await postJson(4783, '/api/tasks/check', { initData: aliceAuth, taskId: 'join_everything' });
  check('unknown taskId rejected', unknown.status === 400, JSON.stringify(unknown));
  const noAuth = await postJson(4783, '/api/tasks', {});
  check('missing initData rejected', noAuth.status === 401, JSON.stringify(noAuth));
  const badAuth = await postJson(4783, '/api/tasks', { initData: 'hash=' + 'a'.repeat(64) });
  check('forged initData rejected', badAuth.status === 401, JSON.stringify(badAuth));

  console.log('\n6) completion survives a snapshot round-trip');
  const snap = JSON.parse(JSON.stringify(store.getSnapshot()));
  check('snapshot carries tasksDone', snap.tasksDone && snap.tasksDone['900101'] && snap.tasksDone['900101'].join_channel, JSON.stringify(snap.tasksDone));
  check('task history is small and shaped', snap.tasksDone['900101'].join_channel.at > 0 && snap.tasksDone['900101'].join_channel.reward === 1);

  console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
  try { fs.unlinkSync(TMP); } catch (e) {}
  process.exit(failures === 0 ? 0 : 1);
}).catch((err) => {
  console.error('store.ready failed:', err && err.message);
  process.exit(1);
});
