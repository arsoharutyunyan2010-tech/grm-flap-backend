# GRM FLAP — Telegram Mini App with server-verified scores

Pipeline: **Telegram Bot → Mini App → Rewarded Ads → Game → Score → Server → Leaderboard → Weekly GRM rewards**

## Files

| File | Role |
|---|---|
| `index.html` | The game itself, loaded as the Telegram Mini App. |
| `physics.js` | **Shared** deterministic simulation. Loaded by both the browser and the server. |
| `server.js` | Express backend: session issuance, score verification, leaderboard API. |
| `anticheat.js` | Server-side anti-cheat: HMAC session tokens, heartbeats, tap-cadence, revive grants, input sanitization. |
| `telegramAuth.js` | Verifies Telegram `initData` (proves the request really comes from that Telegram user). |
| `store.js` | Data layer (in-memory demo — swap for Redis/Postgres in production; see comments inside). |
| `rewards.js` | Weekly GRM reward tiers + payout stub. |
| `bot.js` | Minimal bot that sends a "Play" button opening the Mini App. |
| `img/ui/` | Optimized, lazy-loaded artwork for game results, PvP, help, tasks and referrals. |

See [UI_ARTWORK.md](UI_ARTWORK.md) for the complete screen mapping, deployment,
asset regeneration and artwork regression tests.

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

The client is **never trusted** for score, revives, balance, or referrals.
A userscript / modified `index.html` / raw `curl` can only send inputs;
the server decides what they are worth (`anticheat.js` + `physics.js`).

- **Server-authoritative replay** (above) — the big one. A modified client
  can only change *when* it flaps, not what happens physically afterward.
- **Telegram auth on every scoring request** — `/api/submit-score` and
  `/api/session-heartbeat` require valid `initData` matching the session
  owner. Stolen `sessionId` alone cannot post a score.
- **HMAC session token** — `start-session` returns a token bound to
  `{sessionId, userId, seed}`. Submit/heartbeat without it is rejected.
- **Atomic one-shot sessions** — `consumeSession` marks the session used
  *before* replay, so two parallel submits cannot both score.
- **Live heartbeats** — runs longer than ~25s of simulated time must ping
  `/api/session-heartbeat` with a monotonically increasing step. A script
  that waits wall-clock then dumps a precomputed `flapLog` fails because
  the heartbeat steps do not match the run.
- **Unearned revives dropped** — `reviveLog` from the client is ignored
  unless the server previously called `grantRevive()` from a verified
  ad S2S postback. Client-side "I watched an ad" is not a grant. PvP never
  allows revives.
- **Human tap-cadence analysis** — bots that flap on the exact minimum
  legal interval (or a perfect metronome) for a high-score run are
  rejected. Repeat offenders get strikes → 12h / 48h temp-ban.
- **Score hard cap** (400) and flap-log size cap (8000).
- **Tap-rate cap** (`MAX_FLAPS_PER_SECOND` in `physics.js`) — flaps faster
  than a human sustainable rate are dropped during replay, client-side and
  server-side identically, so this can't be used to desync the two.
- **Wall-clock pacing check** — `submit-score` rejects a run whose claimed
  simulated duration is longer than the real time elapsed since
  `start-session` (with small slack for latency). You can't precompute a
  10-minute "perfect" run and submit it instantly.
- **Rate limiting** — 6 new games / 2 minutes / user, 250 / day, plus an
  IP bucket. Withdrawals 5/hour, deposits 8/hour.
- **Referral fraud** — a `start_param` cannot mint a ghost upline; the
  referrer must already be a known user. Self-referral and cycles blocked.
- **Money movement** — duplicate deposit `txHash` rejected; withdrawals
  are integer FLAP with a minimum; balances ignore `NaN`.
- **Admin lock** — if `ADMIN_KEY` is missing or shorter than 16 chars,
  every `/internal/*` mutating route returns 403 (used to compare
  `undefined !== undefined` and fall open). Comparison is timing-safe.
- **No source leak** — the HTTP server only serves `index.html`,
  `physics.js`, `admin.html` and `/img`. It does **not** statically host
  `server.js`, `store.js`, `.env` or `data/store.json`.
- **`ALLOW_INSECURE_DEV` is ignored when `NODE_ENV=production`.**
- **Weekly rewards** — pays the *previous* ISO week and refuses to pay
  the same week twice.

None of this requires trusting the client for anything except *when it
tapped* — everything that turns taps into a score happens on the server.
Run `npm run test` to exercise the checks (anticheat + security + hardening +
persistence suites).

Additional fraud hardening (see `SECURITY_REVIEW.md` for the full audit):

- **New-account score gate** — until an account has 5 server-verified runs it
  cannot post a score above 120 (`NEW_ACCOUNT_RUNS` / `NEW_ACCOUNT_SCORE_CAP`),
  so a throwaway account with a solver bot cannot top the paid weekly board on
  run #1.
- **Behavioural anomaly flags** — the server keeps each player's last 20
  verified scores and records soft admin events on implausible jumps and
  bot-like run-to-run consistency.
- **Deposits** — a `txHash` is single-use forever (even after rejection); with
  on-chain verification enabled, transfers below `MIN_DEPOSIT_NANO_TON`
  (default 0.01 TON) are refused on approve.
- **PvP** — matches between two accounts joined from the same IP are flagged
  (`pvp same-ip match`) for admin review; all PvP routes are per-user
  rate-limited.
- **Admin** — `/internal/users` shows each player's last IP to spot
  multi-account farming; `/internal/health` can no longer be tricked into
  leaking the persist report when `ADMIN_KEY` is unset.

## Moderation and timed game bans

Open `/admin.html`, enter `ADMIN_KEY`, and press **Load**. The **Players / Telegram
user IDs** table lists every verified player. The numeric value in **Telegram user
ID** is the value to paste into **Ban player**. A player's own ID is also shown on
the in-game Profile page; it is the same ID Telegram sends in `initData`.

Enter the duration in minutes (for example, `10`) and press **Ban player**. The
server stores an absolute expiry time and checks it on the access gate, every new
classic/PvP session, heartbeats, score submission, and PvP actions. The Mini App
also displays the remaining time and retries automatically when the timed ban
expires. An already-open round is stopped on its next heartbeat and cannot save
its score.

The HTML file itself can still be downloaded by a browser because Telegram must
be able to load the Mini App before it sends `initData`. What is blocked is game
access: a banned user cannot obtain a server session or start a verified round.
The client must never fall back to offline play after an auth, server, or ban
error.

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

## Tasks (ЗАДАНИЯ) — subscribe to the game's channel & chat

The TASKS page in the Mini App shows subscription tasks for the game's own
Telegram channel and chat. Configuration lives in the environment:

```env
TASKS_CHANNEL=@FFLAPY      # public channel: @username or t.me link
TASKS_CHAT=                # chat: @username or NUMERIC id (-100…); empty = hidden
TASKS_CHANNEL_URL=         # optional: what OPEN opens (else derived)
TASKS_CHAT_URL=            # optional: what OPEN opens (invite link etc.)
TASKS_REWARD_FLAP=1        # one-time FLAP bonus per completed task (0 = off)
```

**The bot (`BOT_TOKEN`) must be an administrator of the channel and the chat** —
otherwise Telegram's `getChatMember` cannot see memberships and CHECK answers
"verification unavailable" (HTTP 503).

### Private chat (t.me/+invite link)?

Telegram does not let a bot resolve an invite link, so a private chat is
verified by its NUMERIC id:

1. Add the bot as an administrator of the chat.
2. Forward any message from that chat to **@userinfobot** (or @getidsbot) —
   it answers with the id, e.g. `-1001234567890`.
3. Set `TASKS_CHAT=-1001234567890` and `TASKS_CHAT_URL=https://t.me/+…`
   (the invite link players should open).

If `TASKS_CHAT` contains only an invite link, the server logs a warning and
hides the chat task instead of showing a CHECK that can never succeed.

Flow: the player taps **OPEN**, joins, returns and taps **✓ CHECK**. The client
calls `POST /api/tasks/check`; the server re-verifies membership via the
Telegram Bot API (`getChatMember`), marks the task done and credits the reward
**exactly once** (persisted in `tasksDone` in the store). Client claims are
never trusted, and a failed/unknown Telegram check never marks the task done.

API:
- `POST /api/tasks` `{ initData }` → `{ tasks: [{ id, kind, url, reward, done }], balance }`
- `POST /api/tasks/check` `{ initData, taskId }` → `{ ok, done, reward, balance }`

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

## TON Connect wallet (Tonkeeper / Wallet / MyTonWallet)

The Wallet page lets players link a real TON wallet via
[`@tonconnect/ui`](https://github.com/ton-connect/sdk) (CDN script in
`index.html`):

- `GET /tonconnect-manifest.json` — the manifest wallet apps fetch when the
  player taps **CONNECT WALLET**. Set `PUBLIC_URL` to your public HTTPS base
  so the manifest is stable in production; without it the URL is derived from
  the request's Host header.
- **Withdraw tab** — the connected address auto-fills the "TON wallet
  address" field (still editable).
- **Top-up tab** — **PAY WITH CONNECTED WALLET** converts the C amount to
  TON (live rate from tonapi.io, CoinGecko fallback), opens a native payment
  confirmation in the connected wallet, and submits the resulting
  transaction **BOC** to `POST /api/deposit` (`{ boc, sender }`).
  The server reads that BOC with `@ton/core` (`parseSignedBoc`) and takes
  three things from the *signed* transaction: the wallet that signed it, the
  address it pays and the exact nanoTON amount. It refuses the request if the
  payment is not addressed to `DEPOSIT_TON_ADDRESS`, otherwise it watches the
  deposit address's history for that transfer — inbound, from that wallet, for
  that amount, not older than the request — and credits the C balance by
  itself. **No admin approval is involved.**
  Why not just look up a hash: the wallet signs an external message to *itself*
  and the blockchain relays the transfer, so the hash of the signed BOC is not
  the hash that appears on the deposit address. Matching (sender + amount +
  time + destination) is what actually works, and it cannot be forged without
  paying. Manual hash-paste top-ups are verified the same automatic way by
  their claimed hash. Each on-chain transfer may only ever pay for ONE request
  (`spentTransfers`), so signing several top-ups for the same payment credits
  only the first. If the chain cannot be reached at all, the request stays
  pending for admin review.
  The payer's wallet address, the signed amount and the verification result are
  stored on the request (`deposit.wallet`, `deposit.expectedNano`,
  `deposit.verifiedBy`) and shown in `admin.html`.

### Automatic crediting end to end

A player who pays never waits for a human, and never has to explain anything:

1. **Pay in the mini app.** The signed BOC proves which wallet paid and for how
   much; the server polls the chain (`AUTO_CREDIT_DELAYS`, ~10 min window) and
   credits the C balance itself.
2. **Two indexers.** Every lookup goes through `scanDepositLedger`, which asks
   toncenter first and falls back to **tonapi** (`TONAPI_URL` / `TONAPI_KEY`)
   when the keyless public endpoint rate-limits or is unreachable. Rows from
   both are normalised to one shape and a transfer's identity is
   `(sender, amount, block time)` — never an indexer-specific id — so the same
   payment cannot be credited twice through two providers.
   `deposit.provider` records which one confirmed it.
3. **Attached (verified) wallets.** The wallet that signed a payment is stored
   on the account (`store.proveTonWallet`, persisted as `tonWallets`). A
   background scan (`DEPOSIT_LINKED_SCAN_MS`, default 60 s) reads the deposit
   address's newest transfers and credits **any** payment from a verified
   wallet by itself — the player can pay straight from Tonkeeper / Wallet /
   My Wallet without opening the top-up form, pasting a hash or pressing
   anything. If they *do* have an open request for that money, that request is
   credited instead of a second record being created.
   Attaching a wallet by itself (`POST /api/wallet/link`) is a convenience only
   and is **never** enough for an automatic credit: an address becomes
   *verified* solely when the server reads it out of a transaction that wallet
   signed. A verified wallet cannot be re-attached to another account.
4. **Manual top-ups** accept a bare hash *or* a whole explorer link
   (tonviewer / tonscan / ton.app) — `extractTxHash` pulls the hash out — and
   are verified and credited automatically the same way.
5. **One transfer, one credit.** `spentTransfers` + the store's permanently
   burned `txHash` make double-crediting impossible, whichever path wins the
   race.
6. **The mini app follows along.** A submitted top-up id is kept in
   `localStorage`, so the watch survives a page switch, a reload or a Telegram
   restart; when the server credits it, balances refresh on the Wallet and
   Profile pages and a toast confirms the amount.

`POST /internal/deposits/scan` (admin key) forces a scan immediately — the
first thing to run when a player says "I paid but nothing arrived".
`GET /internal/stats` reports the scan counters, the number of verified
wallets and the deposit configuration; the same configuration is printed on
every boot so a missing environment variable is visible in the deploy log.

## Production notes

- Swap `store.js`'s in-memory `Map`s for Redis (sessions — short TTL) and a
  real database (leaderboard history, for audit/replay-ability of past
  weeks' payouts).
- Run the server behind HTTPS; Telegram Mini Apps refuse to load over HTTP.
- If you horizontally scale the server, sessions/rate-limits must live in a
  shared store (Redis), not per-process memory.

## Տվյալների պաշտպանություն (Data safety) 🇦🇲

Նպատակը՝ **երբ դու խաղի կոդում որևէ բան փոխես ու նոր deploy անես, խաղացողների
բալանսը, ռեֆեռալները և լիդերբորդի տվյալները չկորչեն։**

### 1. Ամենակարևորը՝ որտեղ են պահվում տվյալները

Տվյալները **երբեք չպետք է պահվեն կոնտեյների ներսում**, որովհետև Railway/Render-ը
ամեն deploy-ի ժամանակ նոր կոնտեյներ է սարքում ու հին ֆայլերը ջնջվում են։

Ճիշտ տարբերակ (անվճար է)՝ **Upstash Redis**

```
UPSTASH_REDIS_REST_URL=https://xxx.upstash.io
UPSTASH_REDIS_REST_TOKEN=xxxxx
```

Այս երկու փոփոխականը դնելուց հետո տվյալները ապրում են Redis-ում՝ կոդից դուրս։
Կարող ես կոդը 100 անգամ փոխել — տվյալները տեղում են։

Այլընտրանք՝ Railway Volume, mount `/data`, և `DATA_FILE=/data/store.json`։

Ստուգել՝ բացիր `GET /internal/health` (առանց key-ի).
`"ok": true`, `"durable": true` → ամեն ինչ կարգին է։
`"durable": false` → **տվյալները ժամանակավոր են, հաջորդ deploy-ը կջնջի դրանք**։

### 2. Ավտոմատ պաշտպանություններ (արդեն միացած են)

| Պաշտպանություն | Ինչ է անում |
|---|---|
| **Load guard** | Եթե սերվերը վերբարձնելիս չի կարողացել կարդալ պահված տվյալները (Redis-ը չի պատասխանել), սերվերը մտնում է DEGRADED ռեժիմ և **արգելում է գրելը**, որ դատարկ վիճակը չգրի իրական տվյալների վրա։ Խաղը շարունակում է աշխատել, դու տեսնում ես կարմիր զգուշացում ադմինում։ |
| **Shrink guard** | Եթե պահվող խաղացողների քանակը հանկարծ կիսով չափ ընկնի, գրելը արգելվում է (կամ ձուլվում է հին տվյալների հետ)։ |
| **Merge on conflict** | Deploy-ի ժամանակ հին ու նոր կոնտեյները մի քիչ ժամանակ միասին են աշխատում։ Հին կոնտեյները փակվելիս այլևս չի ջնջում նոր տվյալները — երկու վիճակները **ձուլվում են** (միավորները՝ max, բալանսները՝ չեն կորչում, ռեֆեռալները՝ միավորվում են)։ |
| **Forward compatibility** | Եթե նոր տարբերակը նոր դաշտեր է ավելացնում, իսկ հետո դու rollback անես հին կոդին, նոր դաշտերը չեն ջնջվում։ Ուրեմն նոր բաժիններ ավելացնելը անվտանգ է։ |
| **Auto backup** | Ամեն ժամ (կարգավորելի) ամբողջ վիճակի snapshot՝ Redis-ում + լոկալ ֆայլով, պահվում է վերջին 48-ը, 30 օր։ Backup է սարքվում նաև ամեն restore-ից առաջ։ |
| **Autosave** | Ամեն 5 րոպեն մեկ պարտադիր պահպանում, նույնիսկ եթե ոչ ոք չի խաղում։ |
| **Graceful shutdown** | SIGTERM/SIGINT-ի ժամանակ վերջին վիճակը merge-ով պահվում է մինչև պրոցեսի փակվելը։ |

### 3. Ադմին գործիքներ

Բոլորը պահանջում են `x-admin-key: <ADMIN_KEY>` header (կամ պարզապես բացիր
`/admin.html`, մուտքագրիր key-ը և սեղմիր Load):

| Endpoint | Ինչի համար |
|---|---|
| `GET /internal/health` | Առողջության ստուգում՝ degraded, durable, players |
| `GET /internal/durability` | **Իրական** ստուգում՝ write→read→delete ամեն redeploy-ից առաջ/հետո |
| `npm run check:durable` | Տերմինալի ստուգում (`node check-durability.js`), exit 0 = անվտանգ |
| `GET /internal/stats` | Վիճակագրություն + պահպանման ախտորոշում |
| `GET /internal/backup` | Ներբեռնել ամբողջ վիճակը JSON ֆայլով |
| `POST /internal/backup` | Վերականգնել վերբեռնված JSON ֆայլից |
| `GET /internal/backups` | Ավտոմատ backup-ների ցուցակ |
| `POST /internal/backups/create` | Հենց հիմա backup սարքել |
| `POST /internal/backups/restore` | `{ "id": "flapy:store:bak:..." }` — վերականգնել |

### 4. Ոսկե կանոն նոր դետալ ավելացնելուց առաջ

1. Բացիր `/admin.html` → **Create backup now** (կամ **Download backup**)։
2. Deploy արա փոփոխությունը։
3. Բացիր `/internal/health` → `"ok": true` և `players` թիվը նույնն է, ինչ առաջ։
4. Եթե ինչ-որ բան սխալ գնաց → **Automatic backups** աղյուսակից սեղմիր
   **Restore** վերջին լավ snapshot-ի վրա։ Ոչ մի խաղացող ոչինչ չի կորցնում։

> Կարևոր՝ խաղի նոր բաժիններ ավելացնելիս խաղացողի տվյալները միշտ պահիր
> `store.js`-ի snapshot-ի մեջ (նոր դաշտ ավելացրու `snapshot()` և `hydrate()`
> ֆունկցիաներում ու գրիր `KNOWN_SNAPSHOT_FIELDS`-ի մեջ) — այդ դեպքում նոր
> ֆունկցիոնալի տվյալները նույնպես կունենան նույն պաշտպանությունը։

**Պահեստի durable կարգավորումը քայլ առ քայլ** (Upstash Redis կամ Railway Volume)՝
տես [PERSISTENCE_SETUP.md](PERSISTENCE_SETUP.md)։ Ամեն redeploy-ից առաջ/հետո բացիր
`GET /internal/durability` (կամ `npm run check:durable`) և համոզվիր, որ `"ok": true`
— այդպես երբեք բալանս/ռեֆեռալ/լիդերբորդ չի կորչի նոր դետալ ավելացնելիս։



