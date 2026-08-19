/**
 * Verifies Telegram Mini App `initData` per Telegram's documented scheme:
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * secret_key = HMAC_SHA256(bot_token, "WebAppData")
 * data_check_string = all fields except `hash`, sorted alphabetically,
 *                      joined as "key=value" with "\n"
 * valid if HMAC_SHA256(data_check_string, secret_key) === hash
 */
const crypto = require('crypto');

function verifyInitData(initData, botToken, maxAgeSeconds) {
  if (!initData || typeof initData !== 'string') {
    return { ok: false, reason: 'missing initData' };
  }
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'missing hash' };
  params.delete('hash');

  const pairs = [];
  for (const [key, value] of params.entries()) pairs.push(`${key}=${value}`);
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const validSignature = timingSafeEqualHex(computedHash, hash);
  if (!validSignature) return { ok: false, reason: 'bad signature' };

  const authDate = parseInt(params.get('auth_date') || '0', 10);
  const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
  if (maxAgeSeconds && ageSeconds > maxAgeSeconds) {
    return { ok: false, reason: 'stale initData' };
  }

  let user = null;
  try { user = JSON.parse(params.get('user') || 'null'); } catch (e) { /* ignore */ }
  if (!user || !user.id) return { ok: false, reason: 'missing user' };

  return { ok: true, user, authDate };
}

function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { verifyInitData };
