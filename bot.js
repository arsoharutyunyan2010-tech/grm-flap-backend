/**
 * Telegram bot: /start requires joining @GRMFLAP and @GRMFLAPCHAT
 * (verified with getChatMember). Only then is the Mini App Play button sent.
 *
 * The bot MUST be an administrator of both the channel and the chat,
 * otherwise Telegram will not let it check membership.
 *
 * Setup:
 *   1. Create a bot with @BotFather, grab its token -> BOT_TOKEN in .env
 *   2. In @BotFather: /newapp (or /mybots -> Bot Settings -> Mini App)
 *      and set the Mini App URL to wherever you host index.html (must be HTTPS).
 *   3. Add this bot as ADMIN of https://t.me/GRMFLAP and https://t.me/GRMFLAPCHAT
 *   4. npm install && node bot.js
 */
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { REQUIRED_CHATS, checkSubscriptions } = require('./subscription.js');

const BOT_TOKEN = process.env.BOT_TOKEN;
const MINI_APP_URL = process.env.MINI_APP_URL || 'https://your-domain.example.com/index.html';

if (!BOT_TOKEN) {
  console.error('Set BOT_TOKEN in your .env file first.');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

function joinKeyboard(result) {
  const rows = REQUIRED_CHATS.map((chat) => {
    const info = (result.channels || []).find((c) => c.username === chat.username);
    const joined = !!(info && info.joined);
    return [{
      text: joined ? `✓ Joined ${chat.title}` : `➕ Join ${chat.title}`,
      url: chat.url,
    }];
  });
  rows.push([{ text: "✅ I've joined — Check", callback_data: 'check_sub' }]);
  return { inline_keyboard: rows };
}

function playKeyboard() {
  return {
    inline_keyboard: [[{ text: '▶ Play GRM FLAP', web_app: { url: MINI_APP_URL } }]],
  };
}

async function sendAccessMessage(chatId, userId, opts) {
  const editMessageId = opts && opts.editMessageId;
  const result = await checkSubscriptions(BOT_TOKEN, userId, { force: !!(opts && opts.force) });

  const payload = result.subscribed
    ? {
        text: 'Welcome to GRM FLAP! Tap to keep the coin flying, climb the weekly leaderboard, and win GRM. 🪙',
        reply_markup: playKeyboard(),
      }
    : {
        text:
          'To play GRM FLAP you must join both of these first:\n\n' +
          '• https://t.me/GRMFLAPCHAT\n' +
          '• https://t.me/GRMFLAP\n\n' +
          'Join both, then tap “I\'ve joined — Check”.',
        reply_markup: joinKeyboard(result),
        disable_web_page_preview: true,
      };

  if (editMessageId) {
    try {
      await bot.editMessageText(payload.text, {
        chat_id: chatId,
        message_id: editMessageId,
        reply_markup: payload.reply_markup,
        disable_web_page_preview: payload.disable_web_page_preview,
      });
      return;
    } catch (err) {
      // Message is identical or can't be edited — send a fresh one.
    }
  }

  await bot.sendMessage(chatId, payload.text, {
    reply_markup: payload.reply_markup,
    disable_web_page_preview: payload.disable_web_page_preview,
  });
}

bot.onText(/\/start/, (msg) => {
  sendAccessMessage(msg.chat.id, msg.from.id, { force: true }).catch((err) => {
    console.error(' /start subscription check failed:', err);
    bot.sendMessage(msg.chat.id, 'Could not verify subscription right now. Please try /start again in a moment.');
  });
});

bot.on('callback_query', (query) => {
  if (!query || query.data !== 'check_sub') return;
  const chatId = query.message && query.message.chat && query.message.chat.id;
  const userId = query.from && query.from.id;
  const messageId = query.message && query.message.message_id;

  bot.answerCallbackQuery(query.id, { text: 'Checking subscription…' }).catch(() => {});

  sendAccessMessage(chatId, userId, { force: true, editMessageId: messageId }).catch((err) => {
    console.error('callback subscription check failed:', err);
    bot.sendMessage(chatId, 'Could not verify subscription. Please try again.');
  });
});

console.log('Bot running (long polling). Subscription gate: @GRMFLAP + @GRMFLAPCHAT');
