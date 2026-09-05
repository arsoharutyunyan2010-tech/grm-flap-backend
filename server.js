/**
 * GRM FLAP backend
 * -----------------
 * Flow: Telegram Bot -> Mini App (index.html) -> this server -> daily/weekly/monthly
 * leaderboard -> FLAP wallet withdrawal.
 *
 * Playing does NOT credit currency. Score is points only, used for leaderboards.
 * FLAP coins (100 FLAP = $1) live on the wallet and are not earned by flying.
 *
 * The client NEVER gets to tell the server "my score is X". The server
 * replays physics.js from seed + flapLog + reviveLog.
 */
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const P = require('./physics.js');
const { verifyInitData } = require('./telegramAuth.js');
const store = require('./store.js');
const AC = require('./anticheat.js');

// TON Connect: when a player tops up by paying from a connected wallet
// (Tonkeeper / Telegram Wallet / MyTonWallet...), the client sends the signed
// transaction BOC instead of a hand-pasted hash. We hash the BOC server-side
// so admins get a real, searchable message hash in the pending list.
let TonCell = null;
try { TonCell = require('@ton/core').Cell; } catch (err) {
  console.warn('TON Connect top-up hashing disabled (@ton/core missing):', err.message || err);
}
function txHashFromBoc(boc) {
  if (!TonCell) return '';
  if (typeof boc !== 'string' || boc.length < 32 || boc.length > 40000) return '';
  try {
    const cell = TonCell.fromBoc(Buffer.from(boc, 'base64'))[0];
    return cell.hash().toString('hex');
  } catch (err) {
    return '';
  }
}

try {
  const art = require('./art-assets.js');
  const dir = path.join(__dirname, 'img');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, b64] of Object.entries(art)) {
    if (typeof b64 === 'string' && b64.length) {
      fs.writeFileSync(path.join(dir, name), Buffer.from(b64, 'base64'));
    }
  }
  console.log('FLAPY art ready at', dir);
} catch (err) {
  console.error('FLAPY art materialize failed:', err.message || err);
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb', strict: true }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // The Mini App is framed INSIDE Telegram (web.telegram.org / t.me), so a
  // SAMEORIGIN frame option would break it. Allow only Telegram origins to
  // embed us (frame-ancestors replaces X-Frame-Options for modern browsers).
  res.setHeader(
    'Content-Security-Policy',
    "frame-ancestors https://web.telegram.org https://*.telegram.org https://t.me https://*.t.me 'self'"
  );
  res.removeHeader('X-Frame-Options');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // API/user data responses must never be cached by a shared proxy.
  if (req.path.indexOf('/api/') === 0 || req.path.indexOf('/internal/') === 0) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});

// --- Global per-IP request throttle -------------------------------------
// Every authenticated endpoint already has per-user limits, but a script can
// still rotate Telegram identities / hammer unauthenticated routes. This is
// the coarse outer wall: keyed on the proxy-validated IP (see AC.clientIp),
// sliding window, applied to every API/internal route.
const GLOBAL_IP_LIMIT = Number(process.env.GLOBAL_IP_RATE_PER_MIN) || 480;
function ipThrottle(limitPerMin) {
  return (req, res, next) => {
    const ip = AC.clientIp(req);
    if (!store.allowRequest('ipg:' + ip, limitPerMin, 60 * 1000)) {
      return res.status(429).json({ error: 'rate limited, slow down' });
    }
    next();
  };
}
app.use('/api', ipThrottle(GLOBAL_IP_LIMIT));
app.use('/internal', ipThrottle(Math.min(240, GLOBAL_IP_LIMIT)));

// Never serve the whole repo: that used to leak server.js, store.js, .env and
// data/store.json (every balance + TON address) to anyone who guessed the path.
const INDEX_FILE = path.join(__dirname, 'index.html');
app.get(['/', '/index.html'], (req, res, next) => {
  if (fs.existsSync(INDEX_FILE)) return res.sendFile(INDEX_FILE);
  next();
});
app.get('/physics.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.sendFile(path.join(__dirname, 'physics.js'));
});
app.get('/admin.html', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.removeHeader('X-Frame-Options');
  res.setHeader('X-Frame-Options', 'DENY');
  res.sendFile(path.join(__dirname, 'admin.html'));
});
const IMG_DIR = path.join(__dirname, 'img');
if (fs.existsSync(IMG_DIR)) {
  app.use('/img', express.static(IMG_DIR, { fallthrough: false, index: false }));
}

// TON Connect manifest — wallet apps (Tonkeeper, Telegram Wallet, MyTonWallet…)
// fetch this URL when a player taps "Connect wallet" in the mini app.
// PUBLIC_URL pins the base URL in production; otherwise we derive it from the
// incoming request so local/preview deployments still produce a valid manifest.
function publicBaseUrl(req) {
  const envUrl = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (envUrl) return envUrl;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return host ? (proto + '://' + host) : '';
}
app.get('/tonconnect-manifest.json', (req, res) => {
  const base = publicBaseUrl(req);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(JSON.stringify({
    url: base || 'https://localhost',
    name: 'GRM FLAP',
    iconUrl: (base || '') + '/img/tonconnect-icon.png',
  }));
});

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const NODE_ENV = process.env.NODE_ENV || '';
let ALLOW_INSECURE_DEV = process.env.ALLOW_INSECURE_DEV === 'true';
if (NODE_ENV === 'production' && ALLOW_INSECURE_DEV) {
  console.error('ALLOW_INSECURE_DEV is ignored in production — Telegram auth is required.');
  ALLOW_INSECURE_DEV = false;
}
const INIT_DATA_MAX_AGE_SECONDS = 12 * 60 * 60;
if (process.env.SESSION_SECRET || BOT_TOKEN) {
  AC.setSessionSecret(process.env.SESSION_SECRET || BOT_TOKEN);
}

function authenticate(initData) {
  if (ALLOW_INSECURE_DEV && !initData) {
    return { id: 'dev-user', first_name: 'Dev', username: 'dev_tester' };
  }
  const result = verifyInitData(initData, BOT_TOKEN, INIT_DATA_MAX_AGE_SECONDS);
  if (!result.ok) return null;
  return result.user;
}

function displayName(user) {
  const raw = user && user.username ? '@' + user.username : ((user && user.first_name) || 'Player');
  return AC.sanitizeName(raw);
}

function trackTelegramUser(user) {
  if (!user || !user.id) return;
  store.trackUser(String(user.id), {
    name: displayName(user),
    username: user.username || '',
  });
}

function rejectBanned(user, res) {
  if (!user) return false;
  const userId = String(user.id);
  // Read the row once: banInfo performs the expiry check and avoids a small
  // race where isBanned() could expire the row between two calls.
  const info = store.banInfo(userId);
  if (!info) return false;
  const until = Number(info.until);
  res.status(403).json({
    error: 'temporarily banned for cheating',
    code: 'PLAYER_BANNED',
    userId,
    until: until || null,
    minutesLeft: until ? Math.max(1, Math.ceil((until - Date.now()) / 60000)) : null,
    reason: info && info.reason ? info.reason : 'manual ban',
  });
  return true;
}

function startParamFrom(req) {
  let p = String((req.body && (req.body.startParam || req.body.ref)) || '').trim();
  if (p) return p;
  const initData = String((req.body && req.body.initData) || '');
  try {
    p = new URLSearchParams(initData).get('start_param') || '';
  } catch (e) {}
  return p;
}

function ranksFor(userId) {
  const day = store.getUserRank(userId, 'day');
  const week = store.getUserRank(userId, 'week');
  const month = store.getUserRank(userId, 'month');
  return {
    day: day ? day.rank : null,
    week: week ? week.rank : null,
    month: month ? month.rank : null,
  };
}

// Lightweight gate used when the Mini App opens. Static HTML cannot be
// protected by a Telegram user ID, so the client must ask the API before it
// enables the game. start-session still checks the ban again (the ban may be
// created while the page is open).
app.post('/api/access', (req, res) => {
  const user = authenticate(req.body && req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });
  if (rejectBanned(user, res)) return;
  trackTelegramUser(user);
  res.json({ ok: true, userId: String(user.id), name: displayName(user) });
});

app.post('/api/start-session', (req, res) => {
  const user = authenticate(req.body && req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });
  if (rejectBanned(user, res)) return;

  const ip = AC.clientIp(req);
  if (!store.allowRequest('ip:' + ip, 90, 60 * 1000)) {
    return res.status(429).json({ error: 'too many requests, slow down' });
  }
  // 6 new games per 2 minutes — farming a bot at 12/min used to be allowed.
  if (!store.allowRequest('start:' + user.id, 6, 2 * 60 * 1000)) {
    return res.status(429).json({ error: 'too many session starts, slow down' });
  }
  if (!store.allowRequest('startday:' + user.id, 250, 24 * 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'daily session cap reached' });
  }

  const name = displayName(user);
  trackTelegramUser(user);
  store.attachReferral(String(user.id), name, startParamFrom(req));

  const sessionId = crypto.randomBytes(16).toString('hex');
  const seed = crypto.randomInt(1, 2 ** 31 - 1);
  const token = AC.sessionToken(sessionId, String(user.id), seed);
  // Revives are NOT granted here. Ads are client-side and trivially spoofed;
  // a script would just send reviveLog=[crashStep,...]. Score continues only
  // count when grantRevive() is called from a verified S2S ad postback.
  store.createSession(sessionId, String(user.id), seed, { name, token, grantedRevives: 0 });

  res.json({
    sessionId,
    seed,
    token,
    physicsVersion: P.VERSION,
    maxRevives: 0,
  });
});

function replaySession(sessionId, flapLog, totalSteps, reviveLog, opts) {
  opts = opts || {};
  if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 80) {
    return { ok: false, status: 400, error: 'malformed submission' };
  }
  if (!Number.isFinite(totalSteps) || totalSteps < 0) {
    return { ok: false, status: 400, error: 'malformed submission' };
  }
  if (!Array.isArray(flapLog) || flapLog.length > AC.MAX_FLAP_LOG || totalSteps > P.MAX_STEPS_PER_SESSION) {
    return { ok: false, status: 400, error: 'submission too large' };
  }
  const flaps = AC.sanitizeIntArray(flapLog, AC.MAX_FLAP_LOG, P.MAX_STEPS_PER_SESSION);

  const peek = store.getSession(sessionId);
  if (!peek) return { ok: false, status: 404, error: 'unknown or expired session' };
  if (peek.used) return { ok: false, status: 409, error: 'session already submitted' };
  // Submitting another player's session id (or a forged token) is an active
  // forgery attempt, not a client bug — record a strike against the caller.
  if (opts.userId && String(peek.userId) !== String(opts.userId)) {
    store.addStrike(String(opts.userId), 'foreign session attempt', { sessionOwner: String(peek.userId) });
    return { ok: false, status: 403, error: 'session belongs to another user' };
  }
  if (peek.token && !AC.tokensMatch(opts.token, peek.token)) {
    store.addStrike(String(opts.userId || peek.userId), 'bad session token', {});
    return { ok: false, status: 403, error: 'bad session token' };
  }

  const granted = Math.max(0, Number(peek.grantedRevives) || 0);
  const revives = (opts.allowRevives && granted > 0)
    ? AC.sanitizeIntArray(reviveLog, AC.MAX_REVIVE_LOG, P.MAX_STEPS_PER_SESSION).slice(0, granted)
    : [];
  const elapsedRealMs = Date.now() - peek.startedAt;
  const reviveAllowanceMs = revives.length * 4000;
  const timing = AC.checkTiming(totalSteps, elapsedRealMs, reviveAllowanceMs);
  if (!timing.ok) {
    // Burn the session AND record the cheat attempt — a run that "lasted"
    // longer in simulated steps than the wall clock that issued the seed
    // cannot be a real client replay.
    store.consumeSession(sessionId);
    store.addStrike(String(peek.userId), timing.reason, {
      hard: [timing.reason],
      totalSteps,
      elapsedMs: elapsedRealMs,
      claimedMs: timing.claimedMs,
    });
    return { ok: false, status: 400, error: 'submission rejected: implausible timing' };
  }

  // Consume BEFORE simulate so two parallel submits cannot both score.
  const session = store.consumeSession(sessionId);
  if (!session) return { ok: false, status: 409, error: 'session already submitted' };

  const allowedSteps = Math.min(totalSteps, AC.allowedStepsFor(elapsedRealMs, reviveAllowanceMs));
  const replay = P.simulate(session.seed, flaps, allowedSteps, revives);

  const judged = AC.verdict({
    score: replay.score,
    totalSteps: allowedSteps,
    flapLog: flaps,
    elapsedMs: elapsedRealMs,
    heartbeats: session.heartbeats,
    startedAt: session.startedAt,
    revivesUsed: replay.revivesUsed,
    grantedRevives: granted,
    reviveAllowanceMs,
  });
  if (!judged.ok) {
    store.addStrike(session.userId, judged.hard[0] || 'anticheat', { hard: judged.hard, score: replay.score });
    return { ok: false, status: 400, error: 'submission rejected: ' + (judged.hard[0] || 'anticheat') };
  }
  return { ok: true, session, replay, judged, flapLog: flaps };
}

app.post('/api/submit-score', (req, res) => {
  const body = req.body || {};
  const { sessionId, flapLog, totalSteps, clientScore, reviveLog, token } = body;

  const user = authenticate(body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });
  if (rejectBanned(user, res)) return;
  if (!store.allowRequest('submit:' + user.id, 20, 60 * 1000)) {
    return res.status(429).json({ error: 'too many submits, slow down' });
  }

  const verified = replaySession(sessionId, flapLog, totalSteps, reviveLog, {
    allowRevives: true,
    userId: String(user.id),
    token,
  });
  if (!verified.ok) return res.status(verified.status).json({ error: verified.error });

  const session = verified.session;
  const replay = verified.replay;

  const verifiedScore = replay.score;
  const name = session.name || displayName(user);
  store.submitPeriodScores(session.userId, name, verifiedScore);
  const allTimeBest = store.updateAllTimeBest(session.userId, name, verifiedScore);
  const ranks = ranksFor(session.userId);
  store.recordRun();

  res.json({
    score: verifiedScore,
    clientScoreMismatch: verifiedScore !== clientScore,
    best: allTimeBest,
    allTimeBest,
    rank: ranks.week,
    ranks,
    weekKey: store.currentWeekKey(),
    dayKey: store.currentDayKey(),
    monthKey: store.currentMonthKey(),
    revivesUsed: replay.revivesUsed,
    flapBalance: store.getBalance(session.userId),
  });
});

app.post('/api/session-heartbeat', (req, res) => {
  const body = req.body || {};
  const user = authenticate(body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });
  if (rejectBanned(user, res)) return;

  const sessionId = String(body.sessionId || '');
  const session = store.getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'unknown or expired session' });
  if (String(session.userId) !== String(user.id)) {
    return res.status(403).json({ error: 'session belongs to another user' });
  }
  if (session.token && !AC.tokensMatch(body.token, session.token)) {
    return res.status(403).json({ error: 'bad session token' });
  }
  const result = store.addHeartbeat(sessionId, body.step);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

app.get('/api/leaderboard', (req, res) => {
  // Unauthenticated, read-only, but still rate-limited per IP so a scraper
  // script cannot flood it (it sorts the full board on every call).
  const ip = AC.clientIp(req);
  if (!store.allowRequest('lb:' + ip, 45, 60 * 1000)) {
    return res.status(429).json({ error: 'too many requests, slow down' });
  }
  const period = ['day', 'week', 'month'].includes(req.query.period) ? req.query.period : 'day';
  const { ranked, periodKey } = store.getLeaderboard(period, 50);
  const top = ranked.slice(0, 50).map(e => ({ rank: e.rank, name: e.name, score: e.score }));

  let me = null;
  // Normalize the uid: a 1-64 char numeric Telegram id only, so a junk or
  // huge query string can never reach the store.
  const uidRaw = String((req.query && req.query.uid) || '').trim();
  if (uidRaw && /^[0-9]{1,32}$/.test(uidRaw)) {
    const mine = store.getUserRank(uidRaw, period);
    if (mine) me = { rank: mine.rank, score: mine.score };
  }

  res.json({
    period,
    periodKey,
    dayKey: store.currentDayKey(),
    weekKey: store.currentWeekKey(),
    monthKey: store.currentMonthKey(),
    entries: top,
    me,
    referralBoard: period === 'day' ? store.getReferralLeaderboardDay(20) : [],
  });
});

app.post('/api/profile', (req, res) => {
  const user = authenticate(req.body && req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });
  if (rejectBanned(user, res)) return;

  const userId = String(user.id);
  const ranks = ranksFor(userId);

  trackTelegramUser(user);
  store.attachReferral(userId, displayName(user), req.body.startParam || req.body.ref || '');
  const refInfo = store.getReferralInfo(userId, displayName(user));
  const appLink = (process.env.TELEGRAM_APP_LINK || process.env.MINI_APP_SHARE || 'https://t.me/FlapyGameBot/directlink').trim().replace(/\/$/, '');
  const referralLink = appLink
    ? (appLink + (appLink.indexOf('?') >= 0 ? '&' : '?') + 'startapp=' + encodeURIComponent(refInfo.code))
    : ('https://t.me/share/url?url=' + encodeURIComponent(refInfo.code));
  res.json({
    name: displayName(user),
    best: store.getAllTimeBest(userId),
    flapBalance: store.getBalance(userId),
    cBalance: store.getCBalance(userId),
    depositAddress: process.env.DEPOSIT_TON_ADDRESS || 'UQAKc6kclPQL-oe_QeXv-JZ98jI_WBFaLYkWikjWPx3WFqEd',
    rank: ranks.week,
    ranks,
    dayKey: store.currentDayKey(),
    weekKey: store.currentWeekKey(),
    monthKey: store.currentMonthKey(),
    referral: Object.assign({}, refInfo, { link: referralLink }),
    referralBoard: store.getReferralLeaderboardDay(20),
  });
});

const TON_ADDRESS_RE = /^(?:[A-Za-z0-9_-]{48}|-?\d:[0-9a-fA-F]{64})$/;

app.post('/api/withdraw', (req, res) => {
  const user = authenticate(req.body && req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });
  if (rejectBanned(user, res)) return;

  const userId = String(user.id);
  if (!store.allowRequest('withdraw:' + userId, 5, 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'too many withdrawal requests, try again later' });
  }

  const address = String((req.body && req.body.address) || '').trim();
  const amount = Number(req.body && req.body.amount);

  if (!TON_ADDRESS_RE.test(address)) {
    return res.status(400).json({ error: 'invalid TON address format' });
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'invalid amount' });
  }

  const result = store.requestWithdrawal(userId, displayName(user), address, amount);
  if (!result.ok) return res.status(400).json({ error: result.error });

  res.json({ ok: true, requestId: result.request.id, flapBalance: result.balance, balance: result.balance });
});

// TADS widget "reward URL" / postback. Must return 200 or TADS may retry.
// Revives are never granted from this widget — ads are client-side and
// trivially spoofed, so a callback here proves nothing about a real view.
// Keep the route cheap: no body logging (it used to dump untrusted input to
// the log) and no state mutation.
function tadsReward(req, res) {
  res.status(200).json({ ok: true });
}
app.get('/api/tads-reward', tadsReward);
app.post('/api/tads-reward', tadsReward);

app.post('/api/deposit', (req, res) => {
  const user = authenticate(req.body && req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });
  if (rejectBanned(user, res)) return;

  const userId = String(user.id);
  if (!store.allowRequest('deposit:' + userId, 8, 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'too many top-up requests, try again later' });
  }

  const amount = Number(req.body && req.body.amount);
  let txHash = AC.sanitizeTxHash(req.body && req.body.txHash);
  const sender = typeof (req.body && req.body.sender) === 'string'
    ? req.body.sender.trim().slice(0, 80)
    : '';
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'invalid amount' });
  }
  // Paid straight from a connected TON wallet? The client sends the signed
  // transaction BOC — derive its message hash here instead of trusting input.
  if (!txHash && req.body && req.body.boc) {
    txHash = txHashFromBoc(req.body.boc);
    if (!txHash) {
      return res.status(400).json({ error: 'invalid transaction payload' });
    }
  }
  if (!txHash) {
    return res.status(400).json({ error: 'invalid transaction hash' });
  }

  const result = store.requestDeposit(userId, displayName(user), amount, txHash, sender);
  if (!result.ok) return res.status(400).json({ error: result.error });

  res.json({
    ok: true,
    requestId: result.request.id,
    status: result.request.status,
    amount,
    usd: amount / 100,
    flapBalance: store.getBalance(userId),
    cBalance: store.getCBalance(userId),
  });
});

function requireAdmin(req, res) {
  const expected = process.env.ADMIN_KEY;
  // Unset / short keys used to compare `undefined !== undefined` → OPEN admin.
  if (!expected || String(expected).length < 16) {
    res.status(403).json({ error: 'admin not configured' });
    return false;
  }
  // Brute-force lockout: at most 8 admin-key attempts per IP per 10 minutes.
  // A correct key resets nothing (legit use needs far fewer), a wrong one is
  // counted and the caller gets a 429 once the bucket is full.
  const adminIp = 'adminauth:' + AC.clientIp(req);
  if (req.headers['x-admin-key']) {
    if (!AC.safeEqual(req.headers['x-admin-key'], expected)) {
      if (!store.allowRequest(adminIp, 8, 10 * 60 * 1000)) {
        console.warn('admin key brute-force throttled from', AC.clientIp(req));
        res.status(429).json({ error: 'too many admin attempts, try again later' });
        return false;
      }
      res.status(403).json({ error: 'forbidden' });
      return false;
    }
  } else {
    if (!store.allowRequest(adminIp, 8, 10 * 60 * 1000)) {
      res.status(429).json({ error: 'too many admin attempts, try again later' });
      return false;
    }
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  return true;
}

app.get('/internal/withdrawals', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ withdrawals: store.listWithdrawals(req.query.status) });
});

app.post('/internal/withdrawals/:id/paid', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const w = store.markWithdrawalPaid(Number(req.params.id));
  if (!w) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true, withdrawal: w });
});

app.get('/internal/deposits', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ deposits: store.listDeposits(req.query.status) });
});

app.post('/internal/deposits/:id/approve', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const result = store.approveDeposit(Number(req.params.id));
  if (!result) return res.status(404).json({ error: 'not found or already handled' });
  res.json({ ok: true, deposit: result.deposit, flapBalance: store.getBalance(result.deposit.userId), cBalance: result.cBalance != null ? result.cBalance : result.balance });
});

app.post('/internal/deposits/:id/reject', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const d = store.rejectDeposit(Number(req.params.id));
  if (!d) return res.status(404).json({ error: 'not found or already handled' });
  res.json({ ok: true, deposit: d });
});

app.get('/internal/stats', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const runStats = store.getRunStats();
  res.json(Object.assign({
    totalUsers: store.getTotalUsers(),
    activePlayers: store.getActivePlayers(),
    totalRuns: runStats.totalRuns,
  }, store.persistInfo()));
});

// Admin-only directory: Telegram IDs are the value used by /internal/bans.
// It intentionally contains no balances or wallet addresses.
app.get('/internal/users', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ users: store.listUsers(req.query.limit) });
});

app.get('/internal/backup', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const snap = store.getSnapshot();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="flapy-backup.json"');
  res.send(JSON.stringify(snap, null, 2));
});

app.post('/internal/backup', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!req.body || typeof req.body !== 'object' || !req.body.periodBoards) {
    return res.status(400).json({ error: 'invalid backup file' });
  }
  try {
    const info = await store.importSnapshot(req.body);
    res.json({ ok: true, restored: info });
  } catch (err) {
    res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
});

// --- rolling backups / disaster recovery ---------------------------------
app.get('/internal/backups', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    res.json({ backups: await store.listBackups(), persist: store.persistInfo() });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/internal/backups/create', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const result = await store.createBackup((req.body && req.body.label) || 'manual');
  res.status(result.ok ? 200 : 500).json(result);
});

app.post('/internal/backups/restore', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const result = await store.restoreBackup(req.body && req.body.id);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Lightweight health probe. Public (uptime monitors hit it) but must NOT
// leak paths / instance ids / player counts; the full persist report is
// only returned when a valid admin key is supplied.
app.get('/internal/health', (req, res) => {
  const info = store.persistInfo();
  const ok = !info.degraded && info.durable;
  if (req.headers['x-admin-key'] && AC.safeEqual(req.headers['x-admin-key'], process.env.ADMIN_KEY)) {
    return res.status(info.degraded ? 503 : 200).json({ ok, persist: info });
  }
  res.status(info.degraded ? 503 : 200).json({ ok: ok ? true : false });
});

// REAL durability check: performs an actual write + read (and delete)
// round-trip against the live storage backend. Unlike /internal/health this
// does not just trust the env — it proves the backend is reachable AND
// writable right now, so you can confirm right before/after every deploy that
// player data will really survive it.
app.get('/internal/anticheat', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ events: store.listAntiCheatEvents(80) });
});

// Manual moderation: ban a confirmed cheater / lift a ban / inspect bans.
// Only reachable with a valid admin key; userId is validated server-side so
// no arbitrary string can hit the store.
app.get('/internal/bans', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ bans: store.listBans(100) });
});

app.post('/internal/bans', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const userId = String((req.body && req.body.userId) || '').trim();
  // Accept numeric Telegram ids (production) and short alphanumeric/dev ids,
  // but never path-ish or oversized strings that could hit storage weirdly.
  if (!/^[A-Za-z0-9_-]{1,48}$/.test(userId)) {
    return res.status(400).json({ error: 'invalid userId' });
  }
  const minutes = Math.max(1, Math.min(24 * 60 * 30, Math.floor(Number(req.body && req.body.minutes) || 60)));
  const reason = String((req.body && req.body.reason) || 'manual ban').slice(0, 120);
  const row = store.manualBan(userId, reason, minutes);
  res.json({ ok: true, ban: row });
});

app.post('/internal/bans/:userId/unban', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const userId = String(req.params.userId || '').trim();
  if (!/^[A-Za-z0-9_-]{1,48}$/.test(userId)) {
    return res.status(400).json({ error: 'invalid userId' });
  }
  res.json({ ok: true, removed: store.unban(userId) });
});

app.get('/internal/durability', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const persist = store.persistInfo();
    const probe = await store.probeDurability();
    const good = !persist.degraded && probe.ok && (probe.durable !== false);
    res.status(good ? 200 : 503).json({ ok: good, persist, probe });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

const { runWeeklyRewardJob } = require('./rewards.js');
app.post('/internal/run-weekly-rewards', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const result = runWeeklyRewardJob(store);
  res.json(result);
});

app.post('/api/pvp/join', (req, res) => {
  const user = authenticate(req.body && req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });
  if (rejectBanned(user, res)) return;
  trackTelegramUser(user);
  if (!store.allowRequest('pvpjoin:' + user.id, 20, 60 * 1000)) {
    return res.status(429).json({ error: 'too many PvP requests, slow down' });
  }
  const result = store.pvpJoin(String(user.id), displayName(user), Number(req.body.stake));
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(result);
});
app.post('/api/pvp/cancel', (req, res) => {
  const user = authenticate(req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });
  res.json(store.pvpCancel(String(user.id)));
});
app.post('/api/pvp/status', (req, res) => {
  const user = authenticate(req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });
  if (rejectBanned(user, res)) return;
  res.json(store.pvpStatus(String(user.id)));
});
app.post('/api/pvp/submit', (req, res) => {
  const user = authenticate(req.body && req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });
  if (rejectBanned(user, res)) return;
  const userId = String(user.id);
  if (!store.allowRequest('pvpsubmit:' + userId, 20, 60 * 1000)) {
    return res.status(429).json({ error: 'too many PvP submits, slow down' });
  }
  const { sessionId, flapLog, totalSteps, token } = req.body || {};
  // Don't consume a session unless it is actually this player's turn.
  const pre = store.pvpStatus(userId);
  if (pre && pre.match && pre.match.status === 'done') return res.json(pre);
  if (!pre || !pre.match || !pre.match.yourTurn) {
    return res.status(400).json({ error: 'not your turn' });
  }
  const peek = store.getSession(sessionId);
  if (peek && pre.match.turnStartedAt && peek.startedAt < pre.match.turnStartedAt) {
    return res.status(400).json({ error: 'stale session' });
  }
  // PvP never grants ad-revives: replay with an empty revive log so a forged
  // reviveLog can't inflate the stake-settling score.
  const verified = replaySession(sessionId, flapLog, totalSteps, [], {
    allowRevives: false,
    userId,
    token,
  });
  if (!verified.ok) return res.status(verified.status).json({ error: verified.error });
  const result = store.pvpSubmitScore(userId, verified.replay.score, {
    sessionStartedAt: verified.session.startedAt,
  });
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(result);
});
app.post('/api/pvp/decline', (req, res) => {
  const user = authenticate(req.body && req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });
  res.json(store.pvpDecline(String(user.id)));
});
app.post('/api/pvp/forfeit', (req, res) => {
  const user = authenticate(req.body && req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });
  res.json(store.pvpForfeit(String(user.id)));
});
app.post('/api/pvp/heartbeat', (req, res) => {
  const user = authenticate(req.body && req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });
  if (rejectBanned(user, res)) return;
  res.json(store.pvpHeartbeat(String(user.id)));
});
app.post('/api/pvp/ready', (req, res) => {
  const user = authenticate(req.body && req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });
  if (rejectBanned(user, res)) return;
  const result = store.pvpReady(String(user.id));
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(result);
});
app.post('/api/pvp/ack', (req, res) => {
  const user = authenticate(req.body && req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });
  res.json(store.pvpAck(String(user.id)));
});

// --- Error handling ------------------------------------------------------
// Malformed JSON used to fall through to Express's default HTML error page
// (and stack traces). Reply with a clean JSON 400 instead, so a scripted
// client gets a deterministic answer and no internals leak.
app.use((err, req, res, next) => {
  if (err) {
    const status = (err.type === 'entity.too.large') ? 413
      : (err.type === 'entity.parse.failed' || err instanceof SyntaxError) ? 400
      : (Number(err.status) || Number(err.statusCode) || 500);
    if (status >= 500) console.error('unhandled request error:', err.message || err);
    if (!res.headersSent) {
      const body = (req.path.indexOf('/api/') === 0 || req.path.indexOf('/internal/') === 0)
        ? { error: status >= 500 ? 'server error' : (status === 404 ? 'not found' : 'bad request') }
        : 'Not found';
      res.status(status).send(body);
    }
    return;
  }
  next();
});

// Catch-all: never expose directory listings or the repo. Anything not
// explicitly routed gets a minimal 404.
app.use((req, res) => {
  if (req.path.indexOf('/api/') === 0 || req.path.indexOf('/internal/') === 0) {
    return res.status(404).json({ error: 'not found' });
  }
  res.status(404).send('Not found');
});

const PORT = process.env.PORT || 3000;
const start = store.ready || Promise.resolve();
start.then(() => {
  app.listen(PORT, () => {
    const info = store.persistInfo();
    console.log(`GRM FLAP backend listening on :${PORT}`);
    console.log('Persist backend:', info.backend, info.redis ? '(Upstash Redis)' : store.dataFile);
    console.log(`Persist state: ${info.loadState} | players: ${info.players} | durable: ${info.durable}`);
    if (info.warning) console.warn('!!! DATA SAFETY WARNING:', info.warning);
    if (info.degraded) {
      console.error('!!! STORE DEGRADED — saving is blocked to protect existing player data.');
      console.error('    Reason:', info.loadError);
    }
  });
}).catch((err) => {
  console.error('Failed to load store:', err);
  process.exit(1);
});

module.exports = app;
