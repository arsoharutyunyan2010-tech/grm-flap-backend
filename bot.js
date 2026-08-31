/**
 * Minimal Telegram bot: replies to /start with a button that opens the
 * Mini App (GRM FLAP).
 *
 * Setup:
 *   1. Create a bot with @BotFather, grab its token -> BOT_TOKEN in .env
 *   2. In @BotFather: /newapp (or /mybots -> Bot Settings -> Mini App)
 *      and set the Mini App URL to wherever you host index.html (must be HTTPS).
 *   3. npm install node-telegram-bot-api
 *   4. node bot.js
 */
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.BOT_TOKEN;
const MINI_APP_URL = process.env.MINI_APP_URL || 'https://your-domain.example.com/index.html';

if (!BOT_TOKEN) {
  console.error('Set BOT_TOKEN in your .env file first.');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.onText(/\/start(?:\s+(.+))?/, (msg, match) => {
  // Telegram appends the /start payload to the message text when the user
  // opens the bot through a referral (Deep Link) — e.g. `startapp=ref_123`.
  // Forward that parameter into the Mini App URL so the referral is credited.
  let startApp = '';
  try {
    const payload = (match && match[1]) ? match[1].trim() : '';
    if (payload) {
      const params = new URLSearchParams(payload.replace(/^\?/, ''));
      const sa = params.get('startapp') || params.get('start_param');
      if (sa) startApp = sa;
    }
  } catch (e) {
    startApp = '';
  }

  let webAppUrl = MINI_APP_URL;
  if (startApp) {
    const sep = webAppUrl.indexOf('?') >= 0 ? '&' : '?';
    webAppUrl = webAppUrl + sep + 'startapp=' + encodeURIComponent(startApp);
  }

  bot.sendMessage(msg.chat.id, 'Welcome to FLAPY! Tap to keep the coin flying and climb the daily, weekly and monthly leaderboards. 🪙', {
    reply_markup: {
      inline_keyboard: [[
        { text: '▶ Play FLAPY', web_app: { url: webAppUrl } }
      ]]
    }
  });
});

console.log('Bot running (long polling)...');
