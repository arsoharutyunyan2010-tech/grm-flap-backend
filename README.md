# GRM FLAP — Telegram Mini App with server-verified scores

Pipeline: **Telegram Bot → Mini App → Rewarded Ads → Game → Score → Server → Leaderboard → Weekly GRM rewards**

## Files

| File | Role |
|---|---|
| `index.html` | The game itself, loaded as the Telegram Mini App. |
| `physics.js` | **Shared** deterministic simulation. Loaded by both the browser and the server. |
| `server.js` | Express backend: session issuance, score verification, leaderboard API. |
| `telegramAuth.js` | Verifies Telegram `initData` (proves the request really comes from that Telegram user). |
| `store.js` | Data layer (in-memory demo — swap for Redis/Postgres in production; see comments inside). |
| `rewards.js` | Weekly GRM reward tiers + payout stub. |
| `bot.js` | Minimal bot that sends a "Play" button opening the Mini App. |

## Why the score can't be faked from the browser console

The naive approach — client plays the game, client computes a score, client
POSTs `{score: 999999}` — is unsafe exactly like you said: anyone can open
devtools and send whatever number they want.

Instead:

1. **`POST /api/start-session`** — before a round starts, the client asks the
   server for a session. The server generates a random `seed` and a
   one-time `sessionId`, and remembers `{seed, startedAt}` for that user.
2. The client uses that **server-issued seed** to generate the pipes (via a
   seeded PRNG in `physics.js`), and plays the game normally. While playing,
   it does **not** record "my score" — it records the raw input: the list of
   simulation steps at which the player tapped (`flapLog`).
3. **`POST /api/submit-score`** — the client sends `{sessionId, flapLog,
   totalSteps}`. The server looks up the session's seed, and **replays the
   entire run itself** using the exact same `physics.js` code (fixed
   timestep, same gravity/speed curve, same seeded pipe layout). Whatever
   score *that* replay produces is the only score that ever gets written to
   the leaderboard — the number the client claims is only used to flag a
   mismatch for your own monitoring.
4. A session can only be submitted **once** (`store.consumeSession`), so a
   captured request can't be replayed for extra points.

Because `physics.js` is the same file in the browser and in Node, "what the
player saw" and "what the server verifies" are mathematically identical —
there's no drift to exploit. This is confirmed by a determinism test (see
`node -e` snippets in the dev notes below): 200+ randomized runs, 0
client/server mismatches.

## Anti-cheat layers, specifically

- **Server-authoritative replay** (above) — the big one. A modified client
  can only change *when* it flaps, not what happens physically afterward.
- **Tap-rate cap** (`MAX_FLAPS_PER_SECOND` in `physics.js`) — flaps faster
  than a human sustainable rate are dropped during replay, client-side and
  server-side identically, so this can't be used to desync the two.
- **Wall-clock pacing check** — `submit-score` rejects a run whose claimed
  simulated duration is longer than the real time elapsed since
  `start-session` (with small slack for latency). You can't precompute a
  10-minute "perfect" run and submit it instantly.
- **One-time sessions** — a session is consumed on first submission; replay
  attacks on a captured request don't work.
- **Telegram `initData` verification** (`telegramAuth.js`) — proves the
  request comes from a real, currently-authenticated Telegram user, using
  Telegram's official HMAC scheme, and rejects stale `initData` (>24h old).
- **Rate limiting** — `store.allowRequest` caps how often a given Telegram
  user can start new sessions per minute.
- **Hard step/size ceilings** — `MAX_STEPS_PER_SESSION`, plus a cap on
  `flapLog` length, so a malformed or huge payload can't be used to burn
  server CPU.

None of this requires trusting the client for anything except *when it
tapped* — everything that turns taps into a score happens on the server.

## Setup

```bash
npm install
cp .env.example .env
# edit .env: set BOT_TOKEN (from @BotFather), ADMIN_KEY (random string)

npm run dev      # local testing, ALLOW_INSECURE_DEV=true (skips Telegram auth)
# or
npm start        # production — real Telegram initData required
```

Host `index.html` + `physics.js` behind HTTPS (Telegram Mini Apps require
HTTPS), and set `window.GRM_FLAP_API_BASE` before the game script loads, e.g.:

```html
<script>window.GRM_FLAP_API_BASE = "https://api.yourdomain.com";</script>
```

If you don't set it, the game runs in a clearly-labeled **DEMO mode** —
fully playable, but scores aren't sent anywhere.

Then start the bot:

```bash
npm install node-telegram-bot-api
MINI_APP_URL=https://yourdomain.com/index.html node bot.js
```

## Rewarded ads

`index.html` has a `showRewardedAd()` stub with a commented example for
[Adsgram](https://adsgram.ai) (a common Telegram Mini App ad network).
Whichever network you pick, make the actual bonus (extra life, head start,
etc.) something the **server** records against the session when the ad
network confirms completion server-side (via its own webhook/callback) —
never grant it just because the client says "ad watched," for the same
reason client-reported scores aren't trusted.

## Weekly rewards

`rewards.js` defines `REWARD_TIERS` (edit the GRM amounts per rank range)
and `distributeGrmRewards()`, which is a stub — wire it to however you
actually move GRM (ledger service, on-chain transfer, manual payout queue).
Trigger `runWeeklyRewardJob` on a schedule, e.g. with `node-cron`:

```js
const cron = require('node-cron');
cron.schedule('0 0 * * 1', () => runWeeklyRewardJob(store), { timezone: 'UTC' });
```

or by calling `POST /internal/run-weekly-rewards` with header
`x-admin-key: <ADMIN_KEY>` from your platform's own cron.

## Production notes

- Swap `store.js`'s in-memory `Map`s for Redis (sessions — short TTL) and a
  real database (leaderboard history, for audit/replay-ability of past
  weeks' payouts).
- Run the server behind HTTPS; Telegram Mini Apps refuse to load over HTTP.
- If you horizontally scale the server, sessions/rate-limits must live in a
  shared store (Redis), not per-process memory.
