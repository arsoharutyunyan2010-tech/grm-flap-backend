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
const BOTS = require('./bots.js');
const { verifyDepositClaim } = require('./verifyDeposit.js');

// Optional on-chain deposit verification (see verifyDeposit.js). OFF by default
// so existing manual-approval deployments are unaffected; turn on by setting
// DEPOSIT_ONCHAIN_ENABLED=true plus a real DEPOSIT_TON_ADDRESS.
const DEPOSIT_ONCHAIN_ENABLED = process.env.DEPOSIT_ONCHAIN_ENABLED === 'true';
const TON_RPC_URL = (process.env.TON_RPC_URL || '').trim();
const TON_API_KEY = (process.env.TON_API_KEY || '').trim();
// Dust guard for on-chain verified deposits: even a "real" inbound transfer is
// refused if it carried less than this many nanoTON (default 0.01 TON). Stops
// the "pay 0.001 TON, claim 10 000 C" trick where the hash IS genuine. 0 = off.
const MIN_DEPOSIT_NANO_TON = Math.max(0, Math.floor(Number(process.env.MIN_DEPOSIT_NANO_TON) || 10000000));

// ---------------------------------------------------------------------------
// Automatic top-ups from a CONNECTED wallet (TON Connect) and from manual
// hash-paste requests. For connected payments the player signs the transfer
// inside the mini app, so the server knows the exact message (BOC) it should
// look for on-chain. For manual top-ups the pasted txHash is verified to the
// same deposit address. Instead of parking the request in the admin queue, we
// poll the TON indexer until that transfer shows up at the deposit address and
// then credit the account by itself. If verification is unavailable, the
// request remains pending for admin review.
// Turn it off with DEPOSIT_AUTO_CREDIT=false.
const DEPOSIT_AUTO_CREDIT = process.env.DEPOSIT_AUTO_CREDIT !== 'false';
// How long we keep looking for the transfer before leaving it to an admin.
const AUTO_CREDIT_WINDOW_MS = Math.max(
  30 * 1000,
  Math.floor(Number(process.env.DEPOSIT_AUTO_CREDIT_WINDOW_MS) || 10 * 60 * 1000),
);
// Tolerance on the paid value: wallets shave network fees off, and the TON
// price moves between quoting and signing.
const AUTO_CREDIT_TOLERANCE = Math.min(0.5, Math.max(0, Number(process.env.DEPOSIT_AUTO_CREDIT_TOLERANCE) || 0.12));
const FLAP_PER_USD = 100; // 100 C = $1, same rate as the mini app

function depositAddress() {
  return (process.env.DEPOSIT_TON_ADDRESS || 'UQAKc6kclPQL-oe_QeXv-JZ98jI_WBFaLYkWikjWPx3WFqEd').trim();
}

// TON/USD price with a short cache, used to sanity-check what actually landed
// on-chain against the amount of C the player asked for.
let tonPriceCache = { usd: 0, at: 0 };
async function tonUsdPrice() {
  // Escape hatch / offline deployments: a fixed rate can be pinned via env.
  const pinned = Number(process.env.TON_USD_PRICE);
  if (pinned > 0) return pinned;
  const now = Date.now();
  if (tonPriceCache.usd > 0 && now - tonPriceCache.at < 5 * 60 * 1000) return tonPriceCache.usd;
  if (typeof fetch !== 'function') return 0;
  const sources = [
    {
      url: 'https://tonapi.io/v2/rates?tokens=ton&currencies=usd',
      pick: (d) => d && d.rates && d.rates.TON && d.rates.TON.prices && d.rates.TON.prices.USD,
    },
    {
      url: 'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd',
      pick: (d) => d && d['the-open-network'] && d['the-open-network'].usd,
    },
  ];
  for (const src of sources) {
    try {
      const resp = await fetch(src.url, { method: 'GET' });
      if (!resp || !resp.ok) continue;
      const price = Number(src.pick(await resp.json()));
      if (price > 0) {
        tonPriceCache = { usd: price, at: now };
        return price;
      }
    } catch (err) { /* try the next source */ }
  }
  return 0;
}

// Amount of C an on-chain payment is worth. Returns null when we have no price
// (then we simply trust the claimed amount, the transfer itself is verified).
async function creditableAmount(claimed, valueNanoTon) {
  const price = await tonUsdPrice();
  if (!(price > 0) || !(valueNanoTon > 0)) return null;
  const paidUsd = (valueNanoTon / 1e9) * price;
  const paidC = Math.floor(paidUsd * FLAP_PER_USD);
  // Never credit more than the player asked for; if they underpaid by more than
  // the tolerance, credit what actually arrived.
  if (paidC >= Math.floor(claimed * (1 - AUTO_CREDIT_TOLERANCE))) return claimed;
  return Math.max(0, paidC);
}

const autoCreditTimers = new Map();
// Retry schedule (ms from submission): the indexer needs a few seconds to see
// the transfer, then we back off.
const AUTO_CREDIT_DELAYS = [8000, 12000, 20000, 30000, 45000, 60000, 90000, 120000, 150000];

function scheduleAutoCredit(depositId, attempt) {
  if (!DEPOSIT_AUTO_CREDIT) return;
  const id = Number(depositId);
  attempt = Number(attempt) || 0;
  const delay = AUTO_CREDIT_DELAYS[Math.min(attempt, AUTO_CREDIT_DELAYS.length - 1)];
  if (autoCreditTimers.has(id)) clearTimeout(autoCreditTimers.get(id));
  const timer = setTimeout(() => {
    autoCreditTimers.delete(id);
    tryAutoCredit(id, attempt).catch((err) => {
      console.warn('[deposit-auto] #' + id + ' failed:', (err && err.message) || err);
    });
  }, delay);
  if (timer.unref) timer.unref();
  autoCreditTimers.set(id, timer);
}

async function tryAutoCredit(id, attempt) {
  const deposit = store.getDeposit(id);
  if (!deposit || deposit.status !== 'pending' || !deposit.auto) return;
  const address = depositAddress();
  if (!address) return;

  const expired = Date.now() - Number(deposit.requestedAt || 0) > AUTO_CREDIT_WINDOW_MS;
  const vres = await verifyDepositClaim({
    txHash: deposit.txHash,
    depositAddress: address,
    rpcUrl: TON_RPC_URL,
    apiKey: TON_API_KEY,
  });

  if (!vres.ok) {
    if (expired) {
      // Give up quietly: the request stays pending for a human to look at.
      deposit.autoResult = 'not-found: ' + (vres.reason || 'lookup failed');
      console.warn('[deposit-auto] #' + id + ' left for admin:', deposit.autoResult);
      return;
    }
    scheduleAutoCredit(id, attempt + 1);
    return;
  }

  const valueNanoTon = Number(vres.valueNanoTon || 0);
  if (MIN_DEPOSIT_NANO_TON > 0 && valueNanoTon < MIN_DEPOSIT_NANO_TON) {
    deposit.autoResult = 'below minimum on-chain value (' + valueNanoTon + ')';
    store.logEvent(deposit.userId, 'auto top-up below minimum', {
      txHash: deposit.txHash, valueNanoTon, minimum: MIN_DEPOSIT_NANO_TON,
    });
    return;
  }

  const claimed = Number(deposit.amount) || 0;
  const credit = await creditableAmount(claimed, valueNanoTon);
  if (credit != null && credit !== claimed) {
    if (credit <= 0) {
      deposit.autoResult = 'paid value too small to credit';
      return;
    }
    deposit.claimedAmount = claimed;
    deposit.amount = credit;
  }
  deposit.valueNanoTon = valueNanoTon;
  deposit.onchainSource = vres.source || '';

  const result = store.approveDeposit(id);
  if (!result) return;
  deposit.autoApproved = true;
  deposit.autoResult = 'credited';
  store.logEvent(deposit.userId, 'auto top-up credited', {
    depositId: id, amount: deposit.amount, txHash: deposit.txHash, valueNanoTon,
  });
  console.log('[deposit-auto] #' + id + ' credited', deposit.amount, 'C to', deposit.userId);
}

// After a restart, pick up wallet top-ups that were still waiting for their
// transfer to appear on-chain.
function resumeAutoCredits() {
  if (!DEPOSIT_AUTO_CREDIT) return;
  let n = 0;
  for (const d of store.listDeposits('pending')) {
    if (!d || !d.auto) continue;
    if (Date.now() - Number(d.requestedAt || 0) > AUTO_CREDIT_WINDOW_MS) continue;
    scheduleAutoCredit(d.id, 0);
    n++;
  }
  if (n) console.log('[deposit-auto] resumed', n, 'pending wallet top-up(s)');
}

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
// Money-moving / staking calls need a MUCH fresher initData than ordinary
// play. The normal 12h window exists so a player isn't asked to re-auth while
// idling, but a stolen/leaked initData that is up to 12h old must not be able
// to withdraw funds, claim a deposit or stake money in PvP. When the caller
// has to prove identity again anyway, we just demand a freshly-signed token.
const SENSITIVE_MAX_AGE_SECONDS =
  Math.max(60, Math.floor(Number(process.env.SENSITIVE_AUTH_MAX_AGE_SECONDS) || (20 * 60)));
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

// Same as authenticate() but enforces the tighter sensitive window. If a
// leaked initData is older than SENSITIVE_MAX_AGE_SECONDS the Telegram client
// will simply re-open and mint a fresh one, so this only ever blocks an
// attacker who captured an old token — never a legit user.
function authenticateFresh(initData) {
  if (ALLOW_INSECURE_DEV && !initData) {
    return { id: 'dev-user', first_name: 'Dev', username: 'dev_tester' };
  }
  const result = verifyInitData(initData, BOT_TOKEN, SENSITIVE_MAX_AGE_SECONDS);
  if (!result.ok) return null;
  return result.user;
}

function displayName(user) {
  const raw = user && user.username ? '@' + user.username : ((user && user.first_name) || 'Player');
  return AC.sanitizeName(raw);
}

function trackTelegramUser(user, ip) {
  if (!user || !user.id) return;
  store.trackUser(String(user.id), {
    name: displayName(user),
    username: user.username || '',
    ip: ip || '',
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
  if (!store.allowRequest('access:' + user.id, 30, 60 * 1000)) {
    return res.status(429).json({ error: 'too many requests, slow down' });
  }
  trackTelegramUser(user, AC.clientIp(req));
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
  trackTelegramUser(user, ip);
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

  // Fresh-account gate: a brand-new Telegram account cannot post an elite
  // score on its first runs. Not a strike — a legit strong player simply
  // plays a few more (capped) runs first; a throwaway solver-bot account
  // never gets its big score onto the paid leaderboard.
  const gate = store.newAccountGate(session.userId, verifiedScore);
  if (!gate.ok) {
    store.logEvent(session.userId, 'new-account score above cap', {
      score: verifiedScore, cap: gate.cap, verifiedRuns: gate.runs, need: gate.need,
    });
    return res.status(400).json({
      error: 'score not counted: account is too new for a score this high, play a few more runs',
      code: 'NEW_ACCOUNT_CAP',
    });
  }

  const name = session.name || displayName(user);
  // Behavioural anomalies (score jump vs. own history, bot-like consistency)
  // are recorded for the admin BEFORE the run enters the history.
  const anomalies = store.checkScoreAnomaly(session.userId, verifiedScore);
  for (const a of anomalies) store.logEvent(session.userId, a.reason, a);

  store.submitPeriodScores(session.userId, name, verifiedScore);
  const allTimeBest = store.updateAllTimeBest(session.userId, name, verifiedScore);
  store.recordVerifiedRun(session.userId, verifiedScore);
  // A verified run proves a real player — count any pending referral now (once).
  // Anti-self-referral: opening a referral link alone no longer counts an invite.
  store.activateReferral(session.userId, name);
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
  if (!store.allowRequest('hb:' + user.id, 90, 60 * 1000)) {
    return res.status(429).json({ error: 'too many heartbeats, slow down' });
  }

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
  const { ranked, allRanked, periodKey } = store.getLeaderboard(period, 50);
  let list = ranked;
  if (period === 'day') {
    // Pad the daily board with low-record filler bots. Every real player that
    // appears pushes the lowest-scoring bot out; when 25 real players are on
    // the board no bot is left. The set is regenerated on the next day key.
    list = BOTS.padDailyBoard(allRanked, store.currentDayKey())
      .map((e, i) => Object.assign({}, e, { rank: i + 1 }));
  }
  const top = list.slice(0, 50).map(e => ({ rank: e.rank, name: e.name, score: e.score }));

  let me = null;
  // Normalize the uid: a 1-64 char numeric Telegram id only, so a junk or
  // huge query string can never reach the store.
  const uidRaw = String((req.query && req.query.uid) || '').trim();
  if (uidRaw && /^[0-9]{1,32}$/.test(uidRaw)) {
    const mine = store.getUserRank(uidRaw, period);
    if (mine) {
      // On the daily board the visible rank includes the filler bots, so read
      // the rank back from the merged list to stay consistent with the rows.
      const row = period === 'day' ? list.find((e) => e.userId === uidRaw) : null;
      me = { rank: (row && row.rank) || mine.rank, score: mine.score };
    }
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
  if (!store.allowRequest('profile:' + user.id, 30, 60 * 1000)) {
    return res.status(429).json({ error: 'too many requests, slow down' });
  }

  const userId = String(user.id);
  const ranks = ranksFor(userId);

  trackTelegramUser(user, AC.clientIp(req));
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
  const user = authenticateFresh(req.body && req.body.initData);
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
  const user = authenticateFresh(req.body && req.body.initData);
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
  let fromConnectedWallet = false;
  if (!txHash && req.body && req.body.boc) {
    txHash = txHashFromBoc(req.body.boc);
    if (!txHash) {
      return res.status(400).json({ error: 'invalid transaction payload' });
    }
    fromConnectedWallet = true;
  }
  if (!txHash) {
    return res.status(400).json({ error: 'invalid transaction hash' });
  }

  const result = store.requestDeposit(userId, displayName(user), amount, txHash, sender);
  if (!result.ok) return res.status(400).json({ error: result.error });

  // Top-ups are credited automatically: whether the player pays from a
  // connected wallet (BOC) or pastes a transaction hash, the server watches
  // the chain for the exact transfer and approves the request itself once it
  // is confirmed inbound on DEPOSIT_TON_ADDRESS. If verification is unavailable,
  // the request stays pending for a human to review.
  const auto = DEPOSIT_AUTO_CREDIT;
  if (auto) {
    result.request.auto = true;
    result.request.source = fromConnectedWallet ? 'tonconnect' : 'manual';
    scheduleAutoCredit(result.request.id, 0);
  }

  res.json({
    ok: true,
    requestId: result.request.id,
    status: result.request.status,
    auto,
    amount,
    usd: amount / 100,
    flapBalance: store.getBalance(userId),
    cBalance: store.getCBalance(userId),
  });
});

// Rolling, in-memory audit of admin-area access (successful + refused). Capped,
// so it can be exposed to the admin and used to spot a leaked admin key being
// used from an unexpected source / at an odd time.
const adminAudit = [];
function auditAdmin(req, ok) {
  adminAudit.push({
    ok: !!ok,
    ip: AC.clientIp(req),
    method: req.method,
    path: (req.originalUrl || req.url || req.path || '').slice(0, 120),
    at: Date.now(),
  });
  if (adminAudit.length > 300) adminAudit.splice(0, adminAudit.length - 300);
}

// Optional allow-list of source IPs that may touch the admin area at all. When
// set (comma separated), any request from another IP is refused BEFORE the
// key is even tested — so a leaked key is useless outside those networks.
// 'loopback' is shorthand for 127.0.0.1 / ::1 / ::ffff:127.0.0.1.
const ADMIN_IP_ALLOWLIST = (process.env.ADMIN_IP_ALLOWLIST || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
function adminIpAllowed(ip) {
  if (!ADMIN_IP_ALLOWLIST.length) return true;
  if (ADMIN_IP_ALLOWLIST.includes('loopback') &&
      (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1')) return true;
  return ADMIN_IP_ALLOWLIST.includes(ip);
}

// The wholesale write operations (full restore/import + rolling-backup restore)
// are the only /internal actions that can overwrite EVERY balance/score in one
// shot. If RESTORE_KEY is configured, they need a second, separate key in
// addition to the normal admin key — so losing the admin key alone can no
// longer wipe/replace the whole store.
const RESTORE_KEY = process.env.RESTORE_KEY || '';

function requireAdmin(req, res) {
  const expected = process.env.ADMIN_KEY;
  // Unset / short keys used to compare `undefined !== undefined` → OPEN admin.
  if (!expected || String(expected).length < 16) {
    auditAdmin(req, false);
    res.status(403).json({ error: 'admin not configured' });
    return false;
  }
  const clientIp = AC.clientIp(req);
  if (!adminIpAllowed(clientIp)) {
    auditAdmin(req, false);
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  // Brute-force lockout: at most 8 admin-key attempts per IP per 10 minutes.
  // A correct key resets nothing (legit use needs far fewer), a wrong one is
  // counted and the caller gets a 429 once the bucket is full.
  const adminIp = 'adminauth:' + clientIp;
  if (req.headers['x-admin-key']) {
    if (!AC.safeEqual(req.headers['x-admin-key'], expected)) {
      if (!store.allowRequest(adminIp, 8, 10 * 60 * 1000)) {
        console.warn('admin key brute-force throttled from', clientIp);
        auditAdmin(req, false);
        res.status(429).json({ error: 'too many admin attempts, try again later' });
        return false;
      }
      auditAdmin(req, false);
      res.status(403).json({ error: 'forbidden' });
      return false;
    }
  } else {
    if (!store.allowRequest(adminIp, 8, 10 * 60 * 1000)) {
      auditAdmin(req, false);
      res.status(429).json({ error: 'too many admin attempts, try again later' });
      return false;
    }
    auditAdmin(req, false);
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  auditAdmin(req, true);
  return true;
}

// requireAdmin + (optional) separate restore key. Falls back to plain admin
// auth when RESTORE_KEY is not configured, so existing setups keep working.
function requireRestore(req, res) {
  if (!requireAdmin(req, res)) return false;
  if (!RESTORE_KEY || RESTORE_KEY.length < 16) return true; // not configured
  const sent = String(req.headers['x-restore-key'] || '');
  if (!sent || !AC.safeEqual(sent, RESTORE_KEY)) {
    auditAdmin(req, false);
    res.status(403).json({ error: 'restore key required for this operation' });
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

// Status of a single top-up request, for the player who created it. Lets the
// mini app show "credited" as soon as the automatic on-chain check succeeds.
app.post('/api/deposit-status', (req, res) => {
  // Read-only status check — the normal (12h) auth window is enough here, so a
  // long play session can still watch its top-up land.
  const user = authenticate(req.body && req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });
  const userId = String(user.id);
  if (!store.allowRequest('depstatus:' + userId, 120, 10 * 60 * 1000)) {
    return res.status(429).json({ error: 'too many requests, slow down' });
  }
  const deposit = store.getDeposit(Number(req.body && req.body.requestId));
  if (!deposit || String(deposit.userId) !== userId) {
    return res.status(404).json({ error: 'not found' });
  }
  res.json({
    ok: true,
    requestId: deposit.id,
    status: deposit.status,
    auto: !!deposit.auto,
    amount: deposit.amount,
    cBalance: store.getCBalance(userId),
  });
});

app.post('/internal/deposits/:id/approve', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = Number(req.params.id);
  const deposit = store.getDeposit(id);
  if (!deposit) return res.status(404).json({ error: 'not found' });
  if (deposit.status !== 'pending') {
    return res.status(400).json({ error: 'already handled' });
  }
  // On-chain gate: if enabled, the claimed message hash must be found as a real
  // inbound transfer to DEPOSIT_TON_ADDRESS before the account is credited.
  if (DEPOSIT_ONCHAIN_ENABLED) {
    const depositAddress = (process.env.DEPOSIT_TON_ADDRESS || '').trim();
    if (!depositAddress) {
      return res.status(503).json({ error: 'DEPOSIT_ONCHAIN_ENABLED requires DEPOSIT_TON_ADDRESS to be set' });
    }
    const vres = await verifyDepositClaim({
      txHash: deposit.txHash,
      depositAddress,
      rpcUrl: TON_RPC_URL,
      apiKey: TON_API_KEY,
    });
    if (!vres.ok) {
      console.warn('[deposit] on-chain verification refused approve #' + id + ':', vres.reason || vres.http);
      store.addStrike(deposit.userId, 'unverifiable deposit', { txHash: deposit.txHash, reason: vres.reason || String(vres.http || '') });
      return res.status(403).json({ ok: false, error: 'deposit not verified on-chain: ' + (vres.reason || 'lookup failed') });
    }
    // The transfer is genuine — but did it actually carry money? Without this
    // check a real (verifiable) dust transfer of 0.0001 TON could back a
    // claimed top-up of any size, relying on the admin never eyeballing the
    // on-chain value column.
    if (MIN_DEPOSIT_NANO_TON > 0 && Number(vres.valueNanoTon || 0) < MIN_DEPOSIT_NANO_TON) {
      console.warn('[deposit] on-chain value below minimum refused approve #' + id + ':', vres.valueNanoTon, '<', MIN_DEPOSIT_NANO_TON);
      store.logEvent(deposit.userId, 'deposit below on-chain minimum', {
        txHash: deposit.txHash, valueNanoTon: vres.valueNanoTon, minimum: MIN_DEPOSIT_NANO_TON,
      });
      return res.status(403).json({
        ok: false,
        error: 'on-chain transfer is real but below the minimum value (' + vres.valueNanoTon + ' < ' + MIN_DEPOSIT_NANO_TON + ' nanoTON)',
      });
    }
    res.setHeader('X-Deposit-Onchain', 'verified:' + (vres.valueNanoTon || 0));
  }
  const result = store.approveDeposit(id);
  if (!result) return res.status(400).json({ error: 'already handled' });
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
    adminAudit: adminAudit.slice(-50),
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
  if (!requireRestore(req, res)) return;
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
  if (!requireRestore(req, res)) return;
  try {
    const result = await store.restoreBackup(req.body && req.body.id);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Lightweight health probe. Public (uptime monitors hit it) but must NOT
// leak paths / instance ids / player counts; the full persist report is
// only returned when a valid admin key is supplied. The key check mirrors
// requireAdmin: an UNSET admin key must never match anything (comparing
// against String(undefined) let a literal "undefined" header through).
app.get('/internal/health', (req, res) => {
  const info = store.persistInfo();
  const ok = !info.degraded && info.durable;
  const expected = process.env.ADMIN_KEY;
  const keyOk = !!expected && String(expected).length >= 16 &&
    !!req.headers['x-admin-key'] && AC.safeEqual(req.headers['x-admin-key'], expected);
  if (keyOk) {
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
  const user = authenticateFresh(req.body && req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });
  if (rejectBanned(user, res)) return;
  trackTelegramUser(user, AC.clientIp(req));
  if (!store.allowRequest('pvpjoin:' + user.id, 20, 60 * 1000)) {
    return res.status(429).json({ error: 'too many PvP requests, slow down' });
  }
  const result = store.pvpJoin(String(user.id), displayName(user), Number(req.body.stake), AC.clientIp(req));
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(result);
});
app.post('/api/pvp/cancel', (req, res) => {
  const user = authenticate(req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });
  if (!store.allowRequest('pvpcancel:' + user.id, 20, 60 * 1000)) {
    return res.status(429).json({ error: 'too many PvP requests, slow down' });
  }
  res.json(store.pvpCancel(String(user.id)));
});
app.post('/api/pvp/status', (req, res) => {
  const user = authenticate(req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });
  if (rejectBanned(user, res)) return;
  if (!store.allowRequest('pvpstatus:' + user.id, 60, 60 * 1000)) {
    return res.status(429).json({ error: 'too many PvP requests, slow down' });
  }
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
  // Same fresh-account gate as the classic leaderboard: a new account must
  // not bot its way to a stake-winning elite score either. The session is
  // already consumed, but the turn stays open — the player can simply play
  // another run (the gate lifts after a few verified games).
  const pvpGate = store.newAccountGate(userId, verified.replay.score);
  if (!pvpGate.ok) {
    store.logEvent(userId, 'new-account score above cap (pvp)', {
      score: verified.replay.score, cap: pvpGate.cap, verifiedRuns: pvpGate.runs, need: pvpGate.need,
    });
    return res.status(400).json({
      error: 'score not counted: account is too new for a score this high, play a few more runs',
      code: 'NEW_ACCOUNT_CAP',
    });
  }
  store.recordVerifiedRun(userId, verified.replay.score);
  store.activateReferral(userId, verified.session && verified.session.name);
  const result = store.pvpSubmitScore(userId, verified.replay.score, {
    sessionStartedAt: verified.session.startedAt,
  });
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(result);
});
app.post('/api/pvp/decline', (req, res) => {
  const user = authenticate(req.body && req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });
  if (!store.allowRequest('pvpdecl:' + user.id, 20, 60 * 1000)) {
    return res.status(429).json({ error: 'too many PvP requests, slow down' });
  }
  res.json(store.pvpDecline(String(user.id)));
});
app.post('/api/pvp/forfeit', (req, res) => {
  const user = authenticate(req.body && req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });
  if (!store.allowRequest('pvpff:' + user.id, 20, 60 * 1000)) {
    return res.status(429).json({ error: 'too many PvP requests, slow down' });
  }
  res.json(store.pvpForfeit(String(user.id)));
});
app.post('/api/pvp/heartbeat', (req, res) => {
  const user = authenticate(req.body && req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });
  if (rejectBanned(user, res)) return;
  if (!store.allowRequest('pvphb:' + user.id, 60, 60 * 1000)) {
    return res.status(429).json({ error: 'too many PvP requests, slow down' });
  }
  res.json(store.pvpHeartbeat(String(user.id)));
});
app.post('/api/pvp/ready', (req, res) => {
  const user = authenticate(req.body && req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });
  if (rejectBanned(user, res)) return;
  if (!store.allowRequest('pvprdy:' + user.id, 30, 60 * 1000)) {
    return res.status(429).json({ error: 'too many PvP requests, slow down' });
  }
  const result = store.pvpReady(String(user.id));
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(result);
});
app.post('/api/pvp/ack', (req, res) => {
  const user = authenticate(req.body && req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid Telegram auth' });
  if (!store.allowRequest('pvpack:' + user.id, 30, 60 * 1000)) {
    return res.status(429).json({ error: 'too many PvP requests, slow down' });
  }
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
  resumeAutoCredits();
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
