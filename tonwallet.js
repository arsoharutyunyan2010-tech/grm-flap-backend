/**
 * TON wallet helpers: address parsing / user-friendly encoding and
 * TON Connect `ton_proof` verification.
 *
 * Why this file exists: the Wallet page lets players connect Tonkeeper /
 * My Wallet (MyTonWallet) through TON Connect and Telegram Wallet by handle.
 * The client is never trusted about *which* address it owns: when a wallet
 * signs our server-issued challenge (`ton_proof`), we re-verify the signature
 * here with plain Node crypto — no external dependencies.
 *
 * ton_proof layout (see the TON Connect specification):
 *
 *   message   = utf8("ton-proof-item-v2/")
 *             ++ workchain            (int32, big endian)
 *             ++ address hash         (32 bytes, big endian)
 *             ++ domain lengthBytes   (uint32, little endian)
 *             ++ utf8(domain value)
 *             ++ timestamp seconds    (uint64, little endian)
 *             ++ utf8(payload)
 *   signature = Ed25519Sign(privkey,
 *               sha256(0xffff ++ utf8("ton-connect") ++ sha256(message)))
 */
const crypto = require('crypto');

// Wallet providers the UI offers. `telegram` is the custodial @wallet bot:
// it has no on-chain address and no TON Connect support, so it is stored as
// a Telegram handle instead and paid out inside Telegram.
const PROVIDERS = ['tonkeeper', 'mytonwallet', 'telegram'];

const TG_HANDLE_RE = /^@?[a-z0-9_]{4,32}$/i;
// raw:  "0:<64 hex>" (workchain may be negative, e.g. -1 for the masterchain)
const RAW_RE = /^(-?\d+):([0-9a-fA-F]{64})$/;
// user-friendly: 36 bytes base64(url-safe ok) => 48 chars
const FRIENDLY_RE = /^[A-Za-z0-9_-]{48}$/;

const TESTNET_TAG = 0x80;
const TAG_BOUNCEABLE = 0x11;
const TAG_NON_BOUNCEABLE = 0x51;

function crc16Xmodem(buf) {
  let crc = 0x0000;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i] << 8;
    for (let b = 0; b < 8; b++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return crc;
}

function base64UrlDecode(s) {
  let b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return Buffer.from(b64, 'base64');
}

function base64UrlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Parses any TON address the UI may hold (raw "<wc>:<hex64>" or the 48-char
 * user-friendly form, base64 or base64url). Returns null when invalid.
 */
function parseTonAddress(input) {
  const s = String(input == null ? '' : input).trim();
  if (!s || s.length > 128) return null;

  const raw = s.match(RAW_RE);
  if (raw) {
    const workchain = parseInt(raw[1], 10);
    if (workchain < -128 || workchain > 127) return null;
    const hashHex = raw[2].toLowerCase();
    return { workchain, hashHex, raw: workchain + ':' + hashHex, testnet: false };
  }

  if (FRIENDLY_RE.test(s)) {
    const bytes = base64UrlDecode(s);
    if (bytes.length !== 36) return null;
    const body = bytes.subarray(0, 34);
    const crcGiven = bytes.readUInt16BE(34);
    if (crc16Xmodem(body) !== crcGiven) return null;
    const tag = body[0];
    const testnet = (tag & TESTNET_TAG) !== 0;
    const base = tag & ~TESTNET_TAG;
    if (base !== TAG_BOUNCEABLE && base !== TAG_NON_BOUNCEABLE) return null;
    let workchain = body[1];
    if (workchain > 127) workchain -= 256; // signed byte
    const hashHex = body.subarray(2, 34).toString('hex');
    return { workchain, hashHex, raw: workchain + ':' + hashHex, testnet };
  }

  return null;
}

/**
 * Encodes a parsed address back to the user-friendly (base64url) form.
 * `bounceable: false` is what explorers / wallets show for active accounts.
 */
function toFriendly(workchain, hashHex, opts) {
  const o = opts || {};
  const body = Buffer.alloc(34);
  body[0] = (o.bounceable ? TAG_BOUNCEABLE : TAG_NON_BOUNCEABLE) | (o.testnet ? TESTNET_TAG : 0);
  body.writeInt8(workchain, 1);
  Buffer.from(String(hashHex), 'hex').copy(body, 2);
  const crc = Buffer.alloc(2);
  crc.writeUInt16BE(crc16Xmodem(body), 0);
  return base64UrlEncode(Buffer.concat([body, crc]));
}

/** Short "0x1234…abcd" style label for lists. */
function shortAddress(parsed) {
  if (!parsed) return '';
  const f = toFriendly(parsed.workchain, parsed.hashHex, { bounceable: false, testnet: parsed.testnet });
  return f.slice(0, 6) + '…' + f.slice(-6);
}

/**
 * Verifies a TON Connect `ton_proof` reply.
 *
 * @param proof            { timestamp, domain:{lengthBytes,value}, payload, signature }
 * @param parsed           result of parseTonAddress() for the claimed account
 * @param publicKeyHex     hex public key the wallet reported for the account
 * @param expectedDomain   our dApp host (manifestUrl host), e.g. "x.up.railway.app"
 * @param expectedPayload  the server-issued challenge the client had to sign
 * @param maxAgeSec        proof freshness window (default 10 minutes)
 * @returns {{ ok: boolean, reason?: string }}
 */
function verifyTonProof(proof, parsed, publicKeyHex, expectedDomain, expectedPayload, maxAgeSec) {
  try {
    if (!proof || typeof proof !== 'object') return { ok: false, reason: 'missing proof' };
    if (!parsed || !publicKeyHex) return { ok: false, reason: 'missing account' };

    const timestamp = Number(proof.timestamp);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return { ok: false, reason: 'bad timestamp' };
    const windowSec = Number.isFinite(maxAgeSec) ? maxAgeSec : 600;
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - timestamp) > windowSec) return { ok: false, reason: 'proof expired' };

    const domainValue = String((proof.domain && proof.domain.value) || '');
    const domainLen = Number(proof.domain && proof.domain.lengthBytes);
    if (!domainValue || !domainLen) return { ok: false, reason: 'bad domain' };
    if (Buffer.byteLength(domainValue, 'utf8') !== domainLen) return { ok: false, reason: 'domain length mismatch' };
    if (domainValue.toLowerCase() !== String(expectedDomain || '').toLowerCase()) {
      return { ok: false, reason: 'wrong domain' };
    }

    const payload = String(proof.payload || '');
    if (!payload || payload.length > 1024) return { ok: false, reason: 'bad payload' };
    if (String(expectedPayload || '') && payload !== String(expectedPayload)) {
      return { ok: false, reason: 'payload mismatch' };
    }

    const signature = Buffer.from(String(proof.signature || ''), 'base64');
    if (signature.length !== 64) return { ok: false, reason: 'bad signature' };

    const wc = Buffer.alloc(4);
    wc.writeInt32BE(parsed.workchain, 0);
    const dl = Buffer.alloc(4);
    dl.writeUInt32LE(domainLen, 0);
    const ts = Buffer.alloc(8);
    ts.writeBigUInt64LE(BigInt(timestamp), 0);

    const message = Buffer.concat([
      Buffer.from('ton-proof-item-v2/', 'utf8'),
      wc,
      Buffer.from(parsed.hashHex, 'hex'),
      dl,
      Buffer.from(domainValue, 'utf8'),
      ts,
      Buffer.from(payload, 'utf8'),
    ]);
    const inner = crypto.createHash('sha256').update(message).digest();
    const digest = crypto.createHash('sha256')
      .update(Buffer.concat([Buffer.from([0xff, 0xff]), Buffer.from('ton-connect', 'utf8'), inner]))
      .digest();

    const pubHex = String(publicKeyHex).replace(/^0x/i, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(pubHex)) return { ok: false, reason: 'bad public key' };
    // Wrap the raw 32-byte Ed25519 key into an SPKI DER structure so Node's
    // crypto.verify() accepts it without any extra library.
    const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pubHex, 'hex')]);
    const ok = crypto.verify(null, digest, { key: der, format: 'der', type: 'spki' }, signature);
    return ok ? { ok: true } : { ok: false, reason: 'bad signature' };
  } catch (err) {
    return { ok: false, reason: 'verify failed: ' + String((err && err.message) || err) };
  }
}

/** Normalizes a Telegram Wallet handle ("user", "@user", "t.me/user"). */
function normalizeTelegramHandle(input) {
  let s = String(input == null ? '' : input).trim();
  if (!s) return '';
  s = s.replace(/^https?:\/\/t\.me\//i, '');
  if (s[0] !== '@') s = '@' + s;
  if (!TG_HANDLE_RE.test(s)) return '';
  return s.toLowerCase();
}

module.exports = {
  PROVIDERS,
  crc16Xmodem,
  parseTonAddress,
  toFriendly,
  shortAddress,
  verifyTonProof,
  normalizeTelegramHandle,
  RAW_RE,
};
