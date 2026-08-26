/**
 * Server-side Telegram membership checks.
 *
 * The bot MUST be an administrator of every required channel / group,
 * otherwise Telegram returns CHAT_ADMIN_REQUIRED and we cannot tell
 * whether the user joined.
 *
 * Statuses that count as "subscribed":
 *   creator, administrator, member
 *   restricted (only if is_member === true)
 */
const https = require('https');

const REQUIRED_CHATS = [
  {
    id: '@GRMFLAPCHAT',
    username: 'GRMFLAPCHAT',
    title: 'GRM FLAP CHAT',
    url: 'https://t.me/GRMFLAPCHAT',
  },
  {
    id: '@GRMFLAP',
    username: 'GRMFLAP',
    title: 'GRM FLAP',
    url: 'https://t.me/GRMFLAP',
  },
];

const JOINED_STATUSES = new Set(['creator', 'administrator', 'member']);
const SUCCESS_CACHE_MS = 2 * 60 * 1000;
const successCache = new Map();

function telegramGet(botToken, method, params) {
  const qs = new URLSearchParams(params).toString();
  const url = `https://api.telegram.org/bot${botToken}/${method}?${qs}`;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 10000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error('invalid Telegram API response'));
        }
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('Telegram API timeout'));
    });
    req.on('error', reject);
  });
}

function isJoinedMember(result) {
  if (!result || !result.status) return false;
  if (JOINED_STATUSES.has(result.status)) return true;
  if (result.status === 'restricted' && result.is_member) return true;
  return false;
}

async function getMembership(botToken, chatId, userId) {
  const data = await telegramGet(botToken, 'getChatMember', {
    chat_id: chatId,
    user_id: String(userId),
  });
  if (data && data.ok && data.result) {
    return {
      joined: isJoinedMember(data.result),
      status: data.result.status,
      error: null,
    };
  }
  const description = (data && data.description) || 'check failed';
  const notMember = /user not found|USER_NOT_PARTICIPANT|PARTICIPANT_ID_INVALID/i.test(description);
  return {
    joined: false,
    status: null,
    error: notMember ? null : description,
  };
}

function toPublicResult(channels) {
  const byUser = {};
  for (const c of channels) byUser[c.username] = c;
  return {
    subscribed: channels.every((c) => c.joined),
    channelJoined: !!(byUser.GRMFLAP && byUser.GRMFLAP.joined),
    chatJoined: !!(byUser.GRMFLAPCHAT && byUser.GRMFLAPCHAT.joined),
    channels,
  };
}

async function checkSubscriptions(botToken, userId, opts) {
  const force = !!(opts && opts.force);
  const key = String(userId);

  if (!botToken) {
    return {
      subscribed: false,
      channelJoined: false,
      chatJoined: false,
      channels: REQUIRED_CHATS.map((c) => ({
        ...c,
        joined: false,
        status: null,
        error: 'BOT_TOKEN not configured',
      })),
    };
  }

  if (!force) {
    const cached = successCache.get(key);
    if (cached && Date.now() - cached.at < SUCCESS_CACHE_MS) {
      return cached.result;
    }
  }

  const channels = await Promise.all(
    REQUIRED_CHATS.map(async (chat) => {
      try {
        const m = await getMembership(botToken, chat.id, userId);
        if (m.error) {
          console.error(`[subscription] ${chat.id} check failed for ${userId}: ${m.error}`);
        }
        return {
          id: chat.id,
          username: chat.username,
          title: chat.title,
          url: chat.url,
          joined: m.joined,
          status: m.status,
          error: m.error,
        };
      } catch (err) {
        console.error(`[subscription] ${chat.id} error for ${userId}:`, err.message || err);
        return {
          id: chat.id,
          username: chat.username,
          title: chat.title,
          url: chat.url,
          joined: false,
          status: null,
          error: err.message || 'network error',
        };
      }
    })
  );

  const result = toPublicResult(channels);
  if (result.subscribed) {
    successCache.set(key, { at: Date.now(), result });
  } else {
    successCache.delete(key);
  }
  return result;
}

module.exports = {
  REQUIRED_CHATS,
  checkSubscriptions,
};
