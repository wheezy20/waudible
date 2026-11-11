// The Back button closes the open sheet, then the full player, before leaving
// the page, without stopping audio, and never needs two presses.
const { base, books: { b1, b2 }, sleep, check, section, login, waitView: waitViewOn, watchErrors, run } = require('./common');

run(async browser => {
  const page = await (await browser.createBrowserContext()).newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const errors = watchErrors(page);
  let docLoads = 0, pageFetches = 0;
  page.on('request', r => {
    const u = new URL(r.url());
    if (r.resourceType() === 'document') docLoads++;
    else if (['/', '/library'].includes(u.pathname) && r.headers()['hx-request']) pageFetches++;
  });

  const state = () => page.evaluate(() => {
    const a = document.getElementById('audio-player');
    const pg = document.querySelector('#app-content .page');
    const openSheet = document.querySelector('.sheet.is-open, #toc-sidebar.is-open');
    return { url: location.pathname, view: pg && pg.dataset.view, expanded: document.getElementById('player-sheet').classList.contains('is-open'),
             sheet: openSheet ? openSheet.id : null, depth: Layers.depth(), paused: a.paused, same: a === window.__audioRef,
             marker: window.__marker === 1, inertContent: document.getElementById('app-content').inert };
  });
  const waitView = v => waitViewOn(page, v);
  const back = async () => { await page.evaluate(() => history.back()); await sleep(600); };
  const forward = async () => { await page.evaluate(() => history.forward()); await sleep(600); };
  const toLibrary = async () => { await page.click('.bottom-nav a[data-nav="library"]'); await waitView('library'); await sleep(300); };
  const expand = async () => { await page.click('#mini-open'); await sleep(450); };
  const clickIn = async sel => { await page.evaluate(sel => document.querySelector(sel).click(), sel); await sleep(450); };
  // One Back press from Library (with Home behind it) must reach Home
  const onePressHome = async label => {
    await back();
    await waitView('home').catch(() => {});
    const s = await state();
    check(`${label}: then one Back goes to the previous page`, s.url === '/' && s.view === 'home' && !s.expanded && !s.sheet && s.depth === 0
          && !s.paused && s.same, JSON.stringify(s));
    await toLibrary();
  };

  await login(page);
  await page.evaluate(() => { window.__marker = 1; });
  await toLibrary();
  const loads0 = docLoads;

  section('Back collapses the full player');
  const h0 = await page.evaluate(() => history.length);
  await page.click(`#library a[data-open-book="${b1}"]`);
  await page.waitForFunction(() => { const a = document.getElementById('audio-player'); return !a.paused && a.currentTime > 0.2; }, { timeout: 20000 });
  await page.evaluate(() => { window.__audioRef = document.getElementById('audio-player'); });
  let s = await state();
  const h1 = await page.evaluate(() => history.length);
  check('opening the player adds one history entry at the same address', s.expanded && h1 === h0 + 1 && s.url === '/library' && s.depth === 1,
        `history ${h0} -> ${h1}, ${s.url}`);
  let fetches = pageFetches;
  await back();
  s = await state();
  check('Back collapses the player to the mini player', !s.expanded && s.url === '/library' && s.view === 'library' && s.depth === 0 && !s.inertContent,
        JSON.stringify(s));
  check('audio keeps playing, same element, no page reload or fetch', !s.paused && s.same && s.marker && pageFetches === fetches,
        `paused=${s.paused} fetches=${pageFetches - fetches}`);
  const miniFocused = await page.evaluate(() => document.activeElement && document.activeElement.id);
  check('focus goes to the mini player', miniFocused === 'mini-open', miniFocused);

  section('Forward into the closed player entry, then Back');
  await forward();
  s = await state();
  check('Forward does not reopen the player or leave a stale entry', !s.expanded && s.url === '/library' && s.depth === 0, JSON.stringify(s));
  await onePressHome('after Forward');

  section('Closing the player other ways keeps history in sync');
  await expand();
  check('mini player tap expands', (await state()).expanded);
  await clickIn('#player-minimise');
  check('⌄ collapses', !(await state()).expanded);
  await onePressHome('closed by ⌄');

  await expand();
  await page.keyboard.press('Escape'); await sleep(500);
  check('Escape collapses', !(await state()).expanded);
  await onePressHome('closed by Escape');

  await expand();
  const box = await (await page.$('#player-drag')).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + i * 30); await sleep(16); }
  await page.mouse.up(); await sleep(600);
  check('swipe down collapses', !(await state()).expanded);
  await onePressHome('closed by swipe');

  section('Sheets inside the player: Back closes the sheet, then the player');
  const subs = [['More', '#more-btn', 'more-sheet'], ['Sleep', '#sleep-btn', 'sleep-sheet'],
                ['Page text', '#text-btn', 'text-sheet'], ['Contents', '#toc-open-btn', 'toc-sidebar']];
  for (const [name, btn, id] of subs) {
    await expand();
    await clickIn(btn);
    s = await state();
    check(`${name}: opens over the player`, s.sheet === id && s.expanded && s.depth === 2, JSON.stringify(s));
    await back();
    s = await state();
    check(`${name}: Back closes it, player stays open`, !s.sheet && s.expanded && s.depth === 1 && s.url === '/library', JSON.stringify(s));
    await back();
    s = await state();
    check(`${name}: second Back collapses the player`, !s.expanded && s.url === '/library' && s.depth === 0 && !s.paused, JSON.stringify(s));
    await onePressHome(name);
  }

  const closers = [['close button', async () => clickIn('#more-sheet [data-sheet-close]')],
                   ['Escape', async () => { await page.keyboard.press('Escape'); await sleep(450); }],
                   ['tap outside', async () => clickIn('#sheet-backdrop')]];
  for (const [how, close] of closers) {
    await expand(); await clickIn('#more-btn');
    await close();
    s = await state();
    check(`More closed by ${how}: player still open`, !s.sheet && s.expanded && s.depth === 1, JSON.stringify(s));
    await back();
    s = await state();
    check(`More closed by ${how}: one Back collapses the player`, !s.expanded && s.url === '/library', JSON.stringify(s));
    await onePressHome(`More closed by ${how}`);
  }

  await expand(); await clickIn('#sleep-btn'); await clickIn('.sleep-opt[data-sleep="page"]');
  s = await state();
  check('choosing a sleep option closes the sheet only', !s.sheet && s.expanded && s.depth === 1, JSON.stringify(s));
  await back();
  check('then one Back collapses the player', !(await state()).expanded);
  await page.evaluate(() => document.querySelector('.sleep-opt[data-sleep="off"]').click());
  await onePressHome('after sleep option');

  await expand(); await clickIn('#more-btn'); await clickIn('#more-library');
  s = await state();
  check('More > Back to library closes the sheet and the player', !s.sheet && !s.expanded && s.depth === 0 && s.url === '/library', JSON.stringify(s));
  await onePressHome('Back to library');

  await expand(); await clickIn('#toc-open-btn');
  await page.evaluate(() => document.querySelectorAll('#toc-list .toc-item')[1].click()); await sleep(450);
  s = await state();
  check('choosing a chapter closes Contents only', !s.sheet && s.expanded && s.depth === 1, JSON.stringify(s));
  await back();
  check('then one Back collapses the player', !(await state()).expanded);
  await onePressHome('after chapter');

  section('Sheets on the page: Add and book options');
  await clickIn('.bottom-nav button[data-sheet-open="add-sheet"]');
  s = await state();
  check('Add sheet opens', s.sheet === 'add-sheet' && s.depth === 1, JSON.stringify(s));
  await back();
  s = await state();
  check('Back closes the Add sheet and stays on Library', !s.sheet && s.url === '/library' && s.view === 'library' && s.depth === 0, JSON.stringify(s));
  await onePressHome('Add closed by Back');
  await clickIn('.bottom-nav button[data-sheet-open="add-sheet"]');
  await clickIn('#sheet-backdrop');
  check('Add sheet closed by tapping outside', !(await state()).sheet);
  await onePressHome('Add closed by tap outside');

  await clickIn(`#library .card-more[data-book-id="${b2}"]`);
  check('book options sheet opens', (await state()).sheet === 'book-sheet');
  await back();
  s = await state();
  check('Back closes book options', !s.sheet && s.url === '/library' && s.depth === 0, JSON.stringify(s));
  await onePressHome('book options closed by Back');

  section('Play from book options (sheet closes and player opens in the same moment)');
  await clickIn(`#library .card-more[data-book-id="${b1}"]`);
  await clickIn('#book-open');
  s = await state();
  check('same book: player opens, one entry', s.expanded && !s.sheet && s.depth === 1, JSON.stringify(s));
  await back();
  s = await state();
  check('same book: Back collapses', !s.expanded && s.url === '/library' && s.depth === 0, JSON.stringify(s));
  await onePressHome('Play same book');

  await clickIn(`#library .card-more[data-book-id="${b2}"]`);
  await clickIn('#book-open');
  await page.waitForFunction(id => (document.getElementById('audio-player').getAttribute('src') || '').startsWith(`/audio/${id}/`), { timeout: 15000 }, b2);
  await sleep(400);
  s = await state();
  check('other book: player opens with it, one entry', s.expanded && !s.sheet && s.depth === 1 && s.url === '/library', JSON.stringify(s));
  await back();
  s = await state();
  check('other book: Back collapses, still playing', !s.expanded && s.url === '/library' && s.depth === 0 && !s.paused, JSON.stringify(s));
  await onePressHome('Play other book');

  section('Normal page Back/Forward still work');
  await back(); await waitView('home');
  s = await state();
  check('Back with nothing open goes to the previous page', s.url === '/' && s.view === 'home' && !s.paused, JSON.stringify(s));
  await forward(); await waitView('library');
  s = await state();
  check('Forward goes to Library again', s.url === '/library' && s.view === 'library' && !s.expanded, JSON.stringify(s));

  section('Reload while the player is open');
  await expand();
  await page.reload({ waitUntil: 'networkidle2' });
  s = await page.evaluate(() => ({ state: history.state, depth: Layers.depth(),
    expanded: document.getElementById('player-sheet').classList.contains('is-open') }));
  check('after a reload the leftover entry is treated as a page', s.state && !s.state.wLayer && s.depth === 0 && !s.expanded, JSON.stringify(s));

  check('no full page loads during the Back tests (besides the reload)', docLoads - loads0 === 1, `${docLoads - loads0}`);
  check('no JavaScript errors or failed requests', errors.length === 0, errors.slice(0, 5).join(' | '));
});
