# UI artwork integration

The eight illustrations still used by the Mini App (the Tasks chest was removed
from the Tasks screen at the owner's request, together with its source PNG).
The browser loads prepared, mobile-sized **`img/ui/*.webp`** files:
**354,766 bytes total** instead of the multi-megabyte source PNGs.

## Screen mapping

| Source / derivative basename | Where it appears |
| --- | --- |
| `mascot-crash` | Classic crash/continue card; PvP loss |
| `game-over-banner` | Ordinary classic result; pending or rejected verification |
| `trophy-new-best` | A confirmed new classic record (or a local record in explicit demo mode) |
| `pvp-battle-banner` | Stake selection, opponent confirmation, ready/turn cards, and draws |
| `pvp-searching` | Matchmaking queue, with native animated search dots |
| `pvp-win` | PvP victory only; never a loss or draw |
| `how-to-play` | How-to-play modal, alongside the existing translated instructions |
| `referral-friends` | Referral page, above the real invitation link and statistics |

The main-menu background comes from `img/menu-bg.jpg` when that file is present
and falls back to the built-in `img/home-bg.jpg` otherwise; the old
`home-banner.jpg` illustration is no longer shown on the menu. Navigation icons,
game sprites and sound effects are retained.

## Delivery and presentation

- Copy **the whole `img/ui/` directory** with `index.html` when deploying a
  separately hosted frontend. The existing Express `/img` route and Docker
  `COPY . .` already include it; no build step or new public route is needed.
- Do **not** append these images to `art-assets.js` or `window.FLAPY_ART`. Those
  legacy bundles are unchanged. The new files can be cached independently.
- Every new illustration uses native lazy loading, asynchronous decoding and
  explicit dimensions. Hidden screens do not download their art on Home.
- Images are decorative (`alt=""`, `aria-hidden="true"`); translated headings,
  instructions, scores, rewards, links and buttons remain real HTML. A failed
  image is hidden without disabling those controls.
- Artwork modals scroll inside the space between Telegram's safe top inset and
  the bottom navigation. Compact stake chips fit 320px-wide phones. Search-dot
  animation respects `prefers-reduced-motion`.
- The crash mascot's painted checkerboard is converted to actual transparency.
  Game-over mock scores/rewards and matchmaking percentage/player metadata are
  removed. Tutorial art uses only the tap/pipe illustrations, not the source's
  incorrect coin-collection instructions.

## Result state

`POST /api/submit-score` adds a backwards-compatible **`newBest` boolean**, computed
from the verified replay score and the stored account best before updating it.
The trophy and translated badge use this flag, so a stale browser-local record
or a tied account record does not cause a false celebration. The client retains
a comparison fallback for older servers without the flag.

Each classic result resets the previous trophy before verification. Failed live
submissions cannot save a best or earn a trophy, and delayed responses from a
previous session cannot change a later flight's result. Explicit demo mode still
supports local records. PvP artwork follows the server's winner/seat fields and
resets between victories, losses and draws. Scoring physics, stakes, payouts and
wallet logic are unchanged.

## Regenerating derivatives (optional, development only)

From a Python development environment:

```sh
python3 -m pip install Pillow==12.3.0
python3 scripts/prepare-ui-art.py
npm run test:artwork
```

Crop coordinates, alpha masks, size limits and WebP settings live in
`scripts/prepare-ui-art.py`. Generated derivatives are checked in, so production
needs **neither Python nor Pillow**. If changing a derivative's dimensions, also
update its `width`/`height` attributes in `index.html`.

## Verification

`npm test` includes `npm run test:artwork`. The artwork suite checks all nine
files, transfer budgets, image attributes, inline-script syntax, classic record
states, stale/failed responses, PvP outcomes, missing-image handling, the new
server record flag, and real HTTP delivery from an isolated Express instance.
It does not access real player data or external services.

For browser smoke checks, use mocked APIs/isolated accounts, not funded production
matches. Check all screen transitions at 320×568, 360×640, 390×844 and 768×1024;
scroll to every action button; change the UI language; enable reduced motion;
and block an artwork request to verify the native UI remains usable.
