// The persistent player: audio keeps playing across htmx navigation.
const { base, books: { b1, b2, b3 }, env, sleep, check, section, login, waitPlaying, waitView, watchErrors, RECORDER, run } = require('./common');

run(async browser => {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await page.evaluateOnNewDocument(RECORDER);
  const errors = watchErrors(page);
  const saves = [], docLoads = [];
  page.on('request', r => {
    const u = new URL(r.url());
    if (u.pathname === '/save_progress') saves.push(JSON.parse(r.postData()));
    if (r.resourceType() === 'document') docLoads.push(u.pathname);
  });

  const state = () => page.evaluate(() => {
    const a = document.getElementById('audio-player');
    const pg = document.querySelector('#app-content .page');
    return { url: location.pathname, view: pg && pg.dataset.view, sameAudio: a === window.__audioRef,
             paused: a.paused, time: a.currentTime, src: a.getAttribute('src') ? new URL(a.src).pathname : '',
             miniHidden: document.getElementById('mini-player').hidden,
             miniTitle: document.getElementById('mini-title').textContent, miniSub: document.getElementById('mini-sub').textContent,
             expanded: document.getElementById('player-sheet').classList.contains('is-open'),
             marker: window.__marker === 1, audios: document.querySelectorAll('audio').length };
  });

  await login(page);
  await page.evaluate(() => { window.__marker = 1; });

  section('Start playing, collapse, navigate');
  await page.click(`#library a[data-open-book="${b1}"]`);
  await waitPlaying(page);
  await page.evaluate(() => { window.__audioRef = document.getElementById('audio-player'); });
  let s = await state();
  check('tapping a cover opens the player and plays from the saved page', s.expanded && !s.paused && s.src === `/audio/${b1}/14`, s.src);
  check('opening a book does not change the URL', s.url === '/', s.url);
  await page.click('#player-minimise'); await sleep(500);
  s = await state();
  check('minimise collapses to the mini player, still playing', !s.expanded && !s.miniHidden && !s.paused);
  check('the mini player shows the title and chapter', s.miniTitle.startsWith('Atomic Habits') && s.miniSub === "The Man Who Didn't Look Right",
        `${s.miniTitle} | ${s.miniSub}`);
  const t0 = s.time;
  await page.click('.bottom-nav a[data-nav="library"]'); await waitView(page, 'library'); await sleep(1200);
  s = await state();
  check('Library: URL and content changed without a page load', s.url === '/library' && s.marker, s.url);
  check('Library: the same audio element keeps playing', s.sameAudio && !s.paused && s.time > t0 + 0.8 && s.audios === 1,
        `${t0.toFixed(1)}s -> ${s.time.toFixed(1)}s`);
  const t1 = s.time;
  await page.click('.bottom-nav a[data-nav="home"]'); await waitView(page, 'home'); await sleep(1200);
  s = await state();
  check('Home: still the same audio, still playing', s.url === '/' && s.sameAudio && !s.paused && s.time > t1 + 0.8);

  section('Back and Forward between pages');
  await page.goBack(); await waitView(page, 'library'); await sleep(600);
  s = await state();
  check('Back returns to Library, audio keeps playing', s.url === '/library' && s.sameAudio && !s.paused && s.marker, s.url);
  await page.goForward(); await waitView(page, 'home'); await sleep(400);
  check('Forward returns to Home', (await state()).url === '/');

  section('Lock screen after navigating');
  const ms = await page.evaluate(() => { const m = navigator.mediaSession.metadata;
    return { title: m && m.title, album: m && m.album, actions: Object.keys(window.__ms.actions).sort(), state: navigator.mediaSession.playbackState }; });
  check('metadata still set', ms.title === "The Man Who Didn't Look Right" && ms.album.startsWith('Atomic Habits'), `${ms.title} | ${ms.album}`);
  check('action handlers registered once and still there', JSON.stringify(ms.actions) === JSON.stringify(
    ['nexttrack', 'pause', 'play', 'previoustrack', 'seekbackward', 'seekforward', 'seekto']) && ms.state === 'playing', ms.actions.join(','));
  await page.evaluate(() => window.__ms.actions.nexttrack()); await sleep(800);
  s = await state();
  check('nexttrack works while collapsed', s.src === `/audio/${b1}/15` && !s.paused, s.src);

  section('Progress saving while collapsed');
  saves.length = 0;
  await page.waitForFunction(() => isFinite(document.getElementById('audio-player').duration), { timeout: 30000 });
  await page.evaluate(() => { const a = document.getElementById('audio-player'); a.currentTime = a.duration - 0.4; });
  await page.waitForFunction(b1 => new URL(document.getElementById('audio-player').src).pathname === `/audio/${b1}/16`, { timeout: 15000 }, b1);
  await sleep(500);
  check('at a page end the next page plays and progress is saved', saves.some(v => String(v.book_id) === b1 && v.page === 16),
        JSON.stringify(saves.map(v => v.page)));

  section('Switch to a second book');
  saves.length = 0;
  await page.click('.bottom-nav a[data-nav="library"]'); await waitView(page, 'library');
  await page.click(`#library a[data-open-book="${b2}"]`);
  await page.waitForFunction(b2 => (document.getElementById('audio-player').getAttribute('src') || '').startsWith(`/audio/${b2}/`), { timeout: 15000 }, b2);
  await waitPlaying(page); await sleep(300);
  s = await state();
  check('book 1 progress saved before switching', saves[0] && String(saves[0].book_id) === b1 && saves[0].page === 16, JSON.stringify(saves[0]));
  check('book 2 plays in the same audio element', s.src === `/audio/${b2}/0` && s.sameAudio && !s.paused && s.expanded, s.src);
  await page.keyboard.press('Escape'); await sleep(400);
  s = await state();
  check('Escape collapses; the mini player shows book 2', !s.expanded && s.miniTitle === 'Mere Christianity' && s.miniSub === 'Page 1 of 3',
        `${s.miniTitle} | ${s.miniSub}`);
  await page.click(`#library a[data-open-book="${b2}"]`); await sleep(500);
  const tSame = (await state()).time;
  await sleep(600);
  s = await state();
  check('opening the playing book again just expands it', s.expanded && s.src === `/audio/${b2}/0` && s.time > tSame && !s.paused);
  await page.keyboard.press('Escape'); await sleep(600);

  section('Delete the book that is playing');
  await page.click(`#library a[data-open-book="${b3}"]`);
  await page.waitForFunction(b3 => (document.getElementById('audio-player').getAttribute('src') || '').startsWith(`/audio/${b3}/`), { timeout: 15000 }, b3);
  await waitPlaying(page); await page.keyboard.press('Escape'); await sleep(600);
  // Scroll it clear of the mini player first, as a person would
  await page.$eval(`#library .card-more[data-book-id="${b3}"]`, el => el.scrollIntoView({ block: 'center' })); await sleep(200);
  await page.click(`#library .card-more[data-book-id="${b3}"]`); await sleep(400);
  await page.click('#book-delete'); await sleep(200);
  await page.click('#delete-form button[type=submit]');
  await waitView(page, 'home'); await sleep(800);
  s = await state();
  check('the player is stopped and cleared', s.paused && s.src === '' && s.miniHidden && !s.expanded, JSON.stringify({ src: s.src, mini: !s.miniHidden }));
  check('the book is gone from the page, no full reload', !(await page.$(`a[data-open-book="${b3}"]`)) && s.marker && s.url === '/', s.url);
  const msAfter = await page.evaluate(() => [navigator.mediaSession.metadata, navigator.mediaSession.playbackState]);
  check('lock-screen details cleared', msAfter[0] === null && msAfter[1] === 'none', JSON.stringify(msAfter));

  section('Add a book through the Add sheet');
  await page.click('.bottom-nav button[data-sheet-open="add-sheet"]'); await sleep(400);
  await (await page.$('#upload-form input[name="pdf"]')).uploadFile(env.UPLOAD_PDF);
  await page.select('#genre-select', 'Fiction');
  await Promise.all([page.waitForFunction(() => !!document.querySelector('.shelf[data-genre="Fiction"]'), { timeout: 30000 }),
                     page.click('#upload-form button[type=submit]')]);
  await sleep(600);
  s = await state();
  check('upload through htmx: the new book is on its shelf, no full reload', s.marker && s.url === '/', s.url);
  check('the Add sheet closed', await page.evaluate(() => !document.getElementById('add-sheet').classList.contains('is-open')));

  section('Direct visit and refresh');
  await page.goto(`${base}/read/${b1}`);
  await waitPlaying(page); await sleep(400);
  s = await state();
  check('/read/<id> as a full page opens the player at the saved page', s.expanded && s.src === `/audio/${b1}/16` && !s.marker, s.src);
  for (const path of ['/', '/library', `/read/${b1}`]) {
    await page.goto(`${base}${path}`); await sleep(500);
    check(`refreshing ${path} renders the whole page`, await page.evaluate(() =>
      !!document.querySelector('#app-content .page') && !!document.getElementById('audio-player')));
  }

  section('Session ends during in-app navigation');
  await page.goto(`${base}/`); await page.evaluate(() => { window.__marker = 1; });
  const cookies = await page.cookies(); await page.deleteCookie(...cookies.filter(c => c.name === 'session'));
  await page.click('.bottom-nav a[data-nav="library"]');
  await page.waitForSelector('#email', { timeout: 30000 });
  s = await page.evaluate(() => ({ url: location.pathname + location.search, marker: window.__marker === 1, shell: !!document.getElementById('app-content') }));
  check('a full redirect to the login page (not swapped into the content)', s.url.startsWith('/login') && !s.shell && !s.marker, s.url);

  section('Logout is a full page load');
  await page.type('#email', env.EMAIL); await page.type('#password', env.PASSWORD);
  await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);
  await page.evaluate(() => { window.__marker = 1; });
  await page.click(`#library a[data-open-book="${b1}"]`); await waitPlaying(page); await page.keyboard.press('Escape');
  await page.evaluate(() => document.querySelector('.user-nav form button').click());
  // Escape's history step is a same-page navigation too, so wait for the real URL
  for (let i = 0; i < 300 && !page.url().includes('/login'); i++) await sleep(100);
  await page.waitForSelector('#email', { timeout: 30000 });
  s = await page.evaluate(() => ({ url: location.pathname, marker: window.__marker === 1, audio: !!document.getElementById('audio-player') }));
  check('after logout: the login page, no player or audio left', s.url === '/login' && !s.marker && !s.audio, JSON.stringify(s));

  check('no JavaScript errors or failed requests', errors.length === 0, errors.slice(0, 5).join(' | '));
  await ctx.close();
});
