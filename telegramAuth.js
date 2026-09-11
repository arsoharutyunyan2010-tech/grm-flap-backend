/**
 * Verifies Telegram Mini App `initData`.
 *
 * Security rules:
 * - signature must be a 64-character lowercase/uppercase hex HMAC-SHA256
 * - auth_date must be present and not older than maxAgeSeconds
 * - future-dated auth_date is rejected (clock-skew allowance is intentionally small)
 * - parsed user must contain a positive numeric Telegram id
 */
const crypto = require('crypto');

function verifyInitData(initData, botToken, maxAgeSeconds) {
  if (!botToken || typeof botToken !== 'string') {
    return { ok: false, reason: 'server misconfigured' };
  }
  if (!initData || typeof initData !== 'string' || initData.length > 4096) {
    return { ok: false, reason: 'missing initData' };
  }

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) {
    return { ok: false, reason: 'invalid hash' };
  }
  params.delete('hash');

  const pairs = [];
  for (const [key, value] of params.entries()) pairs.push(`${key}=${value}`);
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (!timingSafeEqualHex(computedHash, hash)) {
    return { ok: false, reason: 'bad signature' };
  }

  const authDate = parseInt(params.get('auth_date') || '0', 10);
  if (!Number.isSafeInteger(authDate) || authDate <= 0) {
    return { ok: false, reason: 'invalid auth_date' };
  }

  const now = Math.floor(Date.now() / 1000);
  const ageSeconds = now - authDate;
  const allowedAge = Number(maxAgeSeconds);
  if (Number.isFinite(allowedAge) && allowedAge > 0) {
    // A small future skew is tolerated for clock differences, but a token that
    // claims to come materially from the future is rejected.
    if (ageSeconds < -60) return { ok: false, reason: 'future auth_date' };
    if (ageSeconds > allowedAge) return { ok: false, reason: 'stale initData' };
  }

  let user = null;
  try { user = JSON.parse(params.get('user') || 'null'); } catch (e) { /* ignore */ }
  if (!user || !Number.isSafeInteger(Number(user.id)) || Number(user.id) <= 0) {
    return { ok: false, reason: 'missing user' };
  }

  return { ok: true, user, authDate };
}

function timingSafeEqualHex(a, b) {
  if (!/^[a-f0-9]{64}$/i.test(a) || !/^[a-f0-9]{64}$/i.test(b)) return false;
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { verifyInitData };
