(function () {
  'use strict';

  // Gold F-coin pattern from the supplied design, kept as a tiny repeating data image
  // so the UI does not depend on an external host.
  const GOLD_F = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAEMuMjoyKkM6NjpLR0NPZKZsZFxcZMySmnmm8dT++u3U6eX//////////+Xp////////////////////////////2wBDAUdLS2RXZMRsbMT//+n/////////////////////////////////////////////////////////////////////wAARCACLAEADASIAAhEBAxEB/8QAGAABAQEBAQAAAAAAAAAAAAAAAQIAAwT/xAAnEAEAAgEDBAICAgMAAAAAAAABAhEAEiExA0FxgVFhEyIykTNSof/EABYBAQEAAAAAAAAAAAAAAAAA/8QAGREAAwEBAQAAAAAAAAAAAAAAAQERExFB/9oADAMBAAIRAxEAPwCdEUEd2+dJEHYMmapH/a9s0ozInHrMGgGwseWVClWX9Yiv1AMKUc5XkUSTZDBaF0t/eUiJdfVYsrvbbAwQI8C5F6ZICn12xjGdCVXa8emsdV898olCEiVqcb9sWZu2YbMiKIHN98uWjgDACARtU8YDoavxgNhY+sqFN6v6yA5ou/msZQKrU+8JJyGC1bTf3lDrsCw85ox/JJbQ4HKNBHgXOd6ZICn12xgqapH5vbMxmR3r1hI0SJWpxv2xZ8tmBRL9QDCmUmveaPTqNqnjMOhq8gyIl+qxZXe22TzRd/NYy6ZVal84BGM6Equ15umsWWrnvm12BYec0Y/kktocXl1BsyIogbt5ctHAGTNUj83tmYzDevWFYbCx9ZUat1ZiVRAMKZLXOQZR3DBeWm8aRL/5iyu/jAwQI8C5F6ZICj8YxjOhKrtePTdK6ue+USmiRK1ON+2LPlswsZEUQ5by5EOAMDRhUbtPGA6eHAbCx9ZUKb1ZAG9HPzjKBXLgo8YLstN4G12BZ7zRj+SS2hxfzlBAjwLkXpkgKPxlwM1SNc3tmYzIt191gmiRLUpxv2xZ8qmBRL9QDClWveaPTqN6k8Zh0NXkGpil+qxZXfxk80XfjGUNq1L5wCMZ0JVdrzdOWllq575idgWe8Ix/JJkSQ4v5y6CyUiKIG7ffLkQ4A9ZM1SNfyvbGUeoRdj1hASsLH1lQ0tsv6xJVEAyakydPvIrSTZiYMqFpv7xpJGqvqspld7bYAECJsLkXpkgNc7ZUYzYjQna83TWLJl/LvlQSNEyepTjftizN1TJslIgiBu33y5Rg7AesaNHp1G2SeMIuhS/GTGVhY7fGVDTJWR6xqh/ao2fddsqfT2rUvnJlRUonozMqF0t/eAk9QFnvCMfyTZEkOLO+URgQ4FyL0TYgo77dsYh6ipGv5XtmmdQg7H3Wc+jJera21ndf2xNUesSqARPGRUmbpr7ziSlG6Uzt0H9csxyxnUTjqCu1ZcpXe23fOfU/x5xZSQFaxEdHeB1NPBXa8elJNTI/a98pf1POefqqdQRrbJFnj//2Q==';

  const css = document.createElement('style');
  css.id = 'grm-ui-home-gameover-fix';
  css.textContent = `
    /* Main menu: supplied repeating gold F-coin background */
    body.grm-home-gold-bg,
    body.grm-home-gold-bg #app,
    body.grm-home-gold-bg .app,
    body.grm-home-gold-bg .page,
    body.grm-home-gold-bg .home-page,
    body.grm-home-gold-bg .home-screen {
      background-image: url("${GOLD_F}") !important;
      background-repeat: repeat !important;
      background-size: 128px 278px !important;
    }

    /* Make the FLAPY/PLAY hero card brighter without changing its layout. */
    .grm-play-card {
      filter: brightness(1.14) saturate(1.12) !important;
      box-shadow: 0 0 28px rgba(244,197,66,.48), inset 0 0 24px rgba(255,215,80,.16) !important;
      border-color: rgba(255,220,90,.95) !important;
    }

    /* Game-over artwork: lift it above dark overlays and make it readable. */
    .grm-gameover-art,
    .grm-gameover-art img {
      opacity: 1 !important;
      visibility: visible !important;
      filter: brightness(1.35) contrast(1.18) saturate(1.18) drop-shadow(0 0 16px rgba(168,72,255,.55)) !important;
    }
  `;
  document.head.appendChild(css);

  function visible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  }

  function markHome() {
    const textNodes = Array.from(document.querySelectorAll('body *')).filter(visible);
    // Remove the two requested labels without touching the FLAPY title/card.
    textNodes.forEach(el => {
      const t = (el.textContent || '').trim();
      if (t === 'Welcome to FLAPY GAMES' || t === 'Welcome to FLAPY' || t === 'GAMES') {
        el.style.display = 'none';
      }
    });

    // Find the PLAY card/button area and brighten its nearest substantial container.
    const play = textNodes.find(el => /^PLAY$/i.test((el.textContent || '').trim()) && !el.closest('.bottom-nav'));
    if (play) {
      let card = play;
      for (let i = 0; i < 4 && card.parentElement; i++) {
        const r = card.getBoundingClientRect();
        if (r.width > 220 && r.height > 70) break;
        card = card.parentElement;
      }
      card.classList.add('grm-play-card');
    }
  }

  function markGameOver() {
    const candidates = Array.from(document.querySelectorAll('img, picture, svg, canvas')).filter(visible);
    candidates.forEach(el => {
      const r = el.getBoundingClientRect();
      // Artwork above the GAME OVER / ИГРА ОКОНЧЕНА title is normally centered in the modal.
      if (r.width >= 100 && r.height >= 70 && r.top < window.innerHeight * 0.62 && r.top > window.innerHeight * 0.08) {
        const box = el.parentElement || el;
        box.classList.add('grm-gameover-art');
      }
    });
  }

  function apply() {
    const bodyText = (document.body && document.body.innerText || '').toLowerCase();
    const over = bodyText.includes('game over') || bodyText.includes('игра окончена');
    document.body.classList.toggle('grm-home-gold-bg', !over);
    markHome();
    if (over) markGameOver();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
  else apply();
  setTimeout(apply, 250);
  setTimeout(apply, 1000);
  new MutationObserver(() => apply()).observe(document.documentElement, {childList:true, subtree:true, characterData:true});
})();
