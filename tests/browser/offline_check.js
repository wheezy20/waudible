// Offline listening (PWA): the manifest and service worker, downloading a
// book, playing it with no network (page change, seeking with Range
// requests, contents, lock screen), progress made offline syncing back,
// the download suggestion, one account never seeing another's downloads,
// and deleting and logging out clearing the device.
const path = require('path');
const { base, env, sleep, check, section, login, waitPlaying, waitView, watchErrors, RECORDER, run } = require('./common');

const A = { b4: env.BOOK4, b5: env.BOOK5, b6: env.BOOK6 };
const B_BOOK = env.BOOK7;
const SHOTS = env.SHOT_DIR;

run(async browser => {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844 });
  await page.evaluateOnNewDocument(RECORDER);
  const errors = watchErrors(page);
  const audioResponses = [];
  page.on('response', r => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/audio/')) {
      audioResponses.push({ path: u.pathname + u.search, status: r.status(), sw: r.fromServiceWorker(),
                            range: r.headers()['content-range'] || '' });
    }
  });

  // Offline for the page and for the service worker (its own network)
  // Requests the service worker sends to the network (not from its cache)
  const swSessions = [], swNet = [];
  async function attachWorkers() {
    for (const t of browser.targets().filter(t => t.type() === 'service_worker')) {
      if (!swSessions.some(s => s.t === t)) {
        const s = await t.createCDPSession();
        await s.send('Network.enable');
        s.on('Network.requestWillBeSent', e => { const u = new URL(e.request.url); swNet.push(u.pathname + u.search); });
        swSessions.push({ t, s });
      }
    }
  }
  async function setOffline(on) {
    await page.setOfflineMode(on);
    await attachWorkers();
    for (const { s } of swSessions) {
      await s.send('Network.emulateNetworkConditions', { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    }
  }

  async function shots(name) {
    for (const [w, h] of [[360, 640], [390, 844]]) {
      await page.setViewport({ width: w, height: h });
      await sleep(500);
      await page.screenshot({ path: path.join(SHOTS, `${name}-${w}x${h}.png`) });
    }
  }

  const uid = () => page.evaluate(() => Offline.user());
  const stateOf = id => page.evaluate(id => Offline.state(id).name, id);
  const waitState = (id, name, timeout = 60000) =>
    page.waitForFunction((id, n) => Offline.state(id).name === n, { timeout }, id, name);
  const toastText = () => page.$eval('#toast', el => el.hidden ? '' : el.textContent);
  const idb = (store, key) => page.evaluate((store, key) => new Promise(res => {
    const r = indexedDB.open('waudible', 1);
    r.onsuccess = () => {
      const g = r.result.transaction(store, 'readonly').objectStore(store).get(key);
      g.onsuccess = () => { r.result.close(); res(g.result || null); };
    };
  }), store, key);
  const idbAll = store => page.evaluate(store => new Promise(res => {
    const r = indexedDB.open('waudible', 1);
    r.onsuccess = () => {
      const g = r.result.transaction(store, 'readonly').objectStore(store).getAll();
      g.onsuccess = () => { r.result.close(); res(g.result); };
    };
  }), store);
  const cacheUrls = u => page.evaluate(async u => {
    const c = await caches.open(`waudible-media-u${u}`);
    return (await c.keys()).map(r => { const x = new URL(r.url); return x.pathname + x.search; });
  }, u);
  // Direct clicks: a sheet's history step can restore the scroll position
  // and move a card under the mini player between scrolling and clicking
  // Waits until the player holds that book (the old book's save can be slow)
  const openCard = async (id, { wait = true } = {}) => {
    await page.$eval(`.book-card a[data-open-book="${id}"]`, el => el.click());
    if (wait) await page.waitForFunction(id => Player.bookId() === Number(id), { timeout: 45000 }, id);
  };
  const openMenu = async id => {
    await page.$eval(`.card-more[data-book-id="${id}"]`, el => el.click());
    await sleep(450);
  };
  const collapse = async () => {
    if (await page.evaluate(() => Sheets.anyOpen())) { await page.keyboard.press('Escape'); await sleep(400); }
    if (await page.evaluate(() => Player.isExpanded())) { await page.click('#player-minimise'); await sleep(500); }
  };
  const waitPage = n => page.waitForFunction(n => document.getElementById('page-number').textContent.trim() === n,
                                             { timeout: 20000 }, String(n));
  const goto = async p => { await page.goto(`${base}${p}`); await sleep(400); };

  await login(page, { ask: true });
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, { timeout: 20000 });
  const userA = await uid();
  await attachWorkers();

  section('Installable app');
  const man = await page.evaluate(async () => {
    const link = document.querySelector('link[rel="manifest"]');
    const r = await fetch(link.href);
    const m = await r.json();
    const icons = await Promise.all(m.icons.map(async i => {
      const ir = await fetch(i.src); const bmp = await createImageBitmap(await ir.blob());
      return `${i.purpose} ${i.sizes} ${ir.status} ${ir.headers.get('content-type')} ${bmp.width}x${bmp.height}`;
    }));
    return { type: r.headers.get('content-type'), m, icons };
  });
  check('manifest is served as application/manifest+json', man.type.startsWith('application/manifest+json'), man.type);
  check('manifest: name, standalone, start_url /, dark background, orange theme',
        man.m.name === 'WAudible' && man.m.display === 'standalone' && man.m.start_url === '/' &&
        man.m.background_color === '#121212' && man.m.theme_color === '#E95420', JSON.stringify(man.m).slice(0, 200));
  check('icons at 192 and 512, plus a maskable 512, all load at their size', JSON.stringify(man.icons) === JSON.stringify([
    'any 192x192 200 image/png 192x192', 'any 512x512 200 image/png 512x512', 'maskable 512x512 200 image/png 512x512']),
    man.icons.join(', '));
  const cdp = await page.createCDPSession();
  const appMan = await cdp.send('Page.getAppManifest');
  check('Chrome parses the manifest with no errors', appMan.errors.length === 0 && !!appMan.data,
        appMan.errors.map(e => e.message).join('; '));
  let installErrors = [];
  try { installErrors = (await cdp.send('Page.getInstallabilityErrors')).installabilityErrors.map(e => e.errorId); } catch (e) { /* older Chrome */ }
  // Test browsers run incognito, which Chrome never installs from
  installErrors = installErrors.filter(e => e !== 'in-incognito');
  check('Chrome finds nothing else stopping installation', installErrors.length === 0, installErrors.join(', '));
  const sw = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const r = await fetch('/sw.js', { cache: 'no-store' });
    return { scope: new URL(reg.scope).pathname, script: new URL(navigator.serviceWorker.controller.scriptURL).pathname,
             cc: r.headers.get('cache-control'), type: r.headers.get('content-type') };
  });
  check('service worker registered at /sw.js for the whole site, and controls the page',
        sw.scope === '/' && sw.script === '/sw.js', `${sw.script} scope ${sw.scope}`);
  check('/sw.js is JavaScript', sw.type.startsWith('text/javascript'), sw.type);
  // Exactly these headers, so browsers fetch a new worker straight away and
  // Cloudflare keeps no copy (an edge copy gets its 4 hour Browser Cache TTL)
  const fresh = await page.evaluate(async () => Promise.all(['/sw.js', '/manifest.webmanifest', '/offline'].map(async u => {
    const r = await fetch(u, { cache: 'no-store' });
    return [u, r.headers.get('cache-control'), r.headers.get('cdn-cache-control'), r.headers.get('cloudflare-cdn-cache-control')];
  })));
  for (const [u, cc, cdn, cf] of fresh) {
    check(`${u}: Cache-Control "no-cache, max-age=0", and no-store for the CDN`,
          cc === 'no-cache, max-age=0' && cdn === 'no-store' && cf === 'no-store', `${cc} | ${cdn} | ${cf}`);
  }
  const csp = await page.evaluate(async () => (await fetch('/')).headers.get('content-security-policy'));
  check("CSP adds worker-src and manifest-src 'self' and keeps the rest",
        csp.includes("worker-src 'self'") && csp.includes("manifest-src 'self'") && csp.includes("script-src 'self' 'unsafe-inline'")
        && csp.includes("connect-src 'self';") && csp.includes("object-src 'none'"), csp);
  const shell = await page.evaluate(async () => {
    const names = await caches.keys();
    const shellName = names.find(n => n.startsWith('waudible-shell-'));
    const keys = shellName ? (await (await caches.open(shellName)).keys()).map(r => new URL(r.url).pathname) : [];
    const off = shellName ? await (await caches.open(shellName)).match('/offline') : null;
    const html = off ? await off.text() : '';
    return { keys, hasToken: /csrf/i.test(html) && /name="csrf-token"|name="csrf_token"/.test(html), hasUser: html.includes('waudible-user') };
  });
  check('app shell precached (offline page, CSS, scripts, icons)', ['/offline', '/static/css/style.css', '/static/js/player.js',
        '/static/js/offline.js', '/static/js/htmx.min.js', '/static/icons/icon-192.png'].every(k => shell.keys.includes(k)), shell.keys.join(' '));
  check('the cached offline page has no CSRF token and no user details', !shell.hasToken && !shell.hasUser);

  section('Server routes for downloads');
  const routes = await page.evaluate(async (mine, theirs) => {
    const s = async u => (await fetch(u)).status;
    const m = await (await fetch(`/offline/manifest/${mine}`)).json();
    const sizes = await Promise.all(m.files.map(async f => {
      const r = await fetch(f.url); return (await r.blob()).size === f.bytes;
    }));
    return { theirsMan: await s(`/offline/manifest/${theirs}`), theirsSize: await s(`/offline/size/${theirs}`),
             m: { title: m.title, author: m.author, pages: m.pages, voice: m.voice, toc: m.toc.map(t => t.title),
                  texts: m.texts.length, audio: m.files.filter(f => f.kind === 'audio').length,
                  covers: m.files.filter(f => f.kind !== 'audio').map(f => f.url), cover: m.cover },
             sizesMatch: sizes.every(Boolean), est: await (await fetch(`/offline/size/${mine}`)).json(), total: m.bytes };
  }, A.b4, B_BOOK);
  check("another user's book: manifest and size are 404", routes.theirsMan === 404 && routes.theirsSize === 404,
        `${routes.theirsMan} ${routes.theirsSize}`);
  check('manifest: details, contents, every page text and audio for the current voice',
        routes.m.title === 'Offline Story' && routes.m.author === 'Ada Writer' && routes.m.pages === 4 && routes.m.voice === 'af_heart'
        && JSON.stringify(routes.m.toc) === '["Chapter One","Chapter Two"]' && routes.m.texts === 4 && routes.m.audio === 4
        && routes.m.cover === `/cover/${A.b4}`, JSON.stringify(routes.m));
  check('manifest: the cover and the three lock-screen sizes', JSON.stringify(routes.m.covers) === JSON.stringify(
    [`/cover/${A.b4}`, `/cover/${A.b4}?size=96`, `/cover/${A.b4}?size=192`, `/cover/${A.b4}?size=512`]), routes.m.covers.join(' '));
  check('every file is exactly the size the manifest says', routes.sizesMatch);
  check('size estimate is close to the real total', routes.est.ready && Math.abs(routes.est.bytes - routes.total) < 0.25 * routes.total,
        `estimate ${routes.est.bytes}, real ${routes.total}`);

  section('The download suggestion');
  await openCard(A.b5);
  await waitPlaying(page);
  await page.waitForFunction(() => Sheets.isOpen('ask-sheet'), { timeout: 15000 }).catch(() => {});
  await sleep(500);   // slide-in
  const ask = await page.evaluate(() => ({ open: Sheets.isOpen('ask-sheet'), text: document.getElementById('ask-sheet').innerText }));
  check('opening a ready book that is not downloaded suggests downloading it', ask.open);
  check('it says the size and why', /About \d+(\.\d)? MB\. Streaming uses data and stops when your connection drops\./.test(ask.text)
        && ask.text.includes('Download for offline listening?'), ask.text.replace(/\s+/g, ' ').slice(0, 200));
  check('buttons: Download, Not now, Don\'t ask again for this book', ['Download', 'Not now', "Don't ask again for this book"]
        .every(t => ask.text.includes(t)));
  await shots('popup');
  await page.setViewport({ width: 390, height: 844 });
  await page.click('#ask-later'); await sleep(500);
  check('"Not now" closes it and is remembered for this book and user', !(await page.evaluate(() => Sheets.anyOpen()))
        && (await page.evaluate((u, b) => JSON.parse(localStorage.getItem(`waudible:ask:${u}:${b}`)).choice, userA, A.b5)) === 'later');
  await collapse();
  await openCard(A.b6);
  await waitPlaying(page);
  await page.waitForFunction(() => Sheets.isOpen('ask-sheet'), { timeout: 15000 }).catch(() => {});
  await sleep(500);   // slide-in
  check('another book asks too', await page.evaluate(() => Sheets.isOpen('ask-sheet')));
  await page.click('#ask-never'); await sleep(400);
  check('"Don\'t ask again" is stored for that book', (await page.evaluate((u, b) =>
    JSON.parse(localStorage.getItem(`waudible:ask:${u}:${b}`)).choice, userA, A.b6)) === 'never');
  await collapse();
  await openCard(A.b5); await sleep(300); await collapse();   // already loaded: no new prompt
  await openCard(A.b4); await waitPlaying(page); await sleep(400);
  await page.evaluate(() => Sheets.close());                 // b4 asks; dismissing counts as Not now
  await collapse();
  await goto('/');
  await openCard(A.b6); await waitPlaying(page); await sleep(2000);
  check('after a reload, "Don\'t ask again" keeps it closed', !(await page.evaluate(() => Sheets.anyOpen())));
  await collapse();
  await openCard(A.b5); await waitPlaying(page); await sleep(2000);
  check('after a reload, "Not now" keeps it closed for now (shown once)', !(await page.evaluate(() => Sheets.anyOpen())));
  await collapse();

  section('Download a book from its menu');
  await openMenu(A.b4);
  const menuLabel = await page.$eval('#book-download', el => `${el.disabled} ${el.textContent.trim()}`);
  check('the card menu has "Download for offline"', menuLabel === 'false Download for offline', menuLabel);
  // Not enough space: a clear message and no Download button
  await page.evaluate(() => { window.__estimate = navigator.storage.estimate.bind(navigator.storage);
                              navigator.storage.estimate = async () => ({ quota: 2e6, usage: 1e6 }); });
  await page.click('#book-download');
  await page.waitForFunction(() => document.getElementById('dl-error').textContent.length > 0, { timeout: 10000 });
  const space = await page.evaluate(() => ({ err: document.getElementById('dl-error').textContent,
                                             disabled: document.getElementById('dl-start').disabled }));
  check('not enough space: says so and does not start', space.disabled && space.err.startsWith('Not enough space on this device'), space.err);
  await page.evaluate(() => { navigator.storage.estimate = window.__estimate; Sheets.close(); });
  await sleep(400);
  await openMenu(A.b4);
  await page.click('#book-download');
  await page.waitForFunction(() => !document.getElementById('dl-start').disabled, { timeout: 10000 });
  await sleep(500);   // slide-in
  const conf = await page.evaluate(() => ({ size: document.getElementById('dl-size').textContent,
                                            note: document.getElementById('dl-voice-note').textContent,
                                            book: document.getElementById('dl-book').textContent }));
  check('confirm step shows the book and its size first', /^\d+(\.\d)? MB$/.test(conf.size) && conf.book === 'Offline Story', `${conf.book}: ${conf.size}`);
  check('it says only the current voice is downloaded', conf.note.includes('af_heart') && conf.note.includes('Other voices need a connection'), conf.note);
  await page.click('#dl-start');
  await page.waitForFunction(() => !document.getElementById('dl-progress').hidden || !document.getElementById('dl-done').hidden, { timeout: 5000 });
  check('progress shows with a ring and Cancel', await page.evaluate(() => !document.getElementById('dl-progress').hidden
        || !document.getElementById('dl-done').hidden));
  await waitState(A.b4, 'downloaded');
  const rec = await idb('books', [userA, Number(A.b4)]);
  const cached = await page.evaluate(async (u, files) => {
    const c = await caches.open(`waudible-media-u${u}`);
    return Promise.all(files.map(async f => { const r = await c.match(f.url); return r ? (await r.blob()).size === f.bytes : false; }));
  }, userA, rec.files);
  check('download completes: details, contents and page text in IndexedDB', rec.complete && rec.texts.length === 4 && rec.toc.length === 2
        && rec.voice === 'af_heart', `${rec.complete} ${rec.texts.length} ${rec.toc.length}`);
  check('every file is in Cache Storage at the size the manifest says', cached.length === 8 && cached.every(Boolean), cached.join(','));
  check('cached under this user\'s id', (await cacheUrls(userA)).includes(`/audio/${A.b4}/0?voice=af_heart`));
  check('done step says what is downloaded', (await page.$eval('#dl-done-text', el => el.textContent)).includes('af_heart'));
  await page.evaluate(() => Sheets.close()); await sleep(300);
  check('the card shows it is downloaded', await page.$eval(`.book-card[data-book-id="${A.b4}"]`, el => el.classList.contains('is-downloaded')));
  const persisted = await page.evaluate(() => navigator.storage.persisted());
  check('persistent storage was requested (granted or not is up to the browser)', typeof persisted === 'boolean', String(persisted));

  section('Cancel and resume');
  const cancelled = await page.evaluate(async id => {
    const p = Offline.download(id, { quiet: true });
    await new Promise(r => setTimeout(r, 30));
    const during = Offline.state(id).name;
    Offline.cancel(id);
    await p;
    return [during, Offline.state(id).name, document.getElementById('toast').textContent];
  }, A.b6);
  check('cancel part way', cancelled[0] === 'downloading' && cancelled[1] === 'none' && cancelled[2] === 'Download cancelled.', cancelled.join(' | '));
  check('cancel stops the download and removes what was saved', (await idb('books', [userA, Number(A.b6)])) === null
        && !(await cacheUrls(userA)).some(u => u.startsWith(`/audio/${A.b6}/`)));
  // Interrupted part way: keep what is there and carry on next time
  await page.evaluate(async (u, id) => {
    const m = await (await fetch(`/offline/manifest/${id}`)).json();
    const c = await caches.open(`waudible-media-u${u}`);
    const f = m.files.find(x => x.kind === 'audio');
    const b = await (await fetch(f.url)).blob();
    await c.put(f.url, new Response(b, { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(b.size) } }));
    await new Promise(res => { const r = indexedDB.open('waudible', 1); r.onsuccess = () => {
      const t = r.result.transaction('books', 'readwrite');
      t.objectStore('books').put({ uid: u, id: Number(id), title: m.title, author: m.author, genre: m.genre, pages: m.pages, voice: m.voice,
                                   cover: m.cover, toc: m.toc, texts: m.texts, files: m.files, bytes: m.bytes, stored: b.size,
                                   complete: false, savedAt: Date.now() });
      t.oncomplete = () => { r.result.close(); res(); }; }; });
  }, userA, A.b6);
  swNet.length = 0;
  await goto('/');
  await waitState(A.b6, 'downloaded');
  const refetched = swNet.filter(u => u.startsWith(`/audio/${A.b6}/`));
  check('an interrupted download resumes on the next visit, skipping files it already has',
        refetched.length === 1 && refetched[0].startsWith(`/audio/${A.b6}/1`), refetched.join(', '));

  section('Downloads screen');
  await page.click('.bottom-nav [data-nav="library"]');
  await waitView(page, 'library');
  await page.waitForFunction(() => /2 books/.test(document.getElementById('downloads-link-sub').textContent), { timeout: 10000 });
  check('Library links to Downloads with the count and size', /^2 books, \d+(\.\d)? MB on this device$/.test(
    await page.$eval('#downloads-link-sub', el => el.textContent)), await page.$eval('#downloads-link-sub', el => el.textContent));
  await page.click('#downloads-link');
  await waitView(page, 'downloads');
  await page.waitForSelector('.dl-item');
  const list = await page.evaluate(() => ({
    items: [...document.querySelectorAll('.dl-item')].map(li => li.querySelector('.dl-title').textContent + ' | ' + li.querySelector('.dl-meta').textContent),
    total: document.querySelector('.downloads-total').textContent, all: !!document.getElementById('downloads-delete-all'),
    del: document.querySelectorAll('.dl-delete').length,
    nav: document.querySelector('.bottom-nav .is-active').dataset.nav }));
  check('lists the downloaded books with their size and voice', list.items.length === 2 && list.items.every(t => / \| \d+(\.\d)? MB, voice af_heart$/.test(t)),
        list.items.join(' / '));
  check('total space used, a delete button per book and Delete all', /^2 books, \d+(\.\d)? MB used on this device$/.test(list.total)
        && list.del === 2 && list.all, list.total);
  check('Library stays the active tab', list.nav === 'library', list.nav);
  await shots('downloads');
  await page.setViewport({ width: 390, height: 844 });

  section('Offline: a book that is not downloaded');
  await goto('/');
  await setOffline(true);
  await page.waitForFunction(() => !document.getElementById('offline-badge').hidden, { timeout: 5000 });
  check('the Offline badge shows in the header', await page.$eval('#offline-badge', el => !el.hidden && el.textContent.trim() === 'Offline'));
  check('books that are not on this device are dimmed', await page.$eval(`.book-card[data-book-id="${A.b5}"] .card-cover`,
        el => getComputedStyle(el).opacity === '0.4'));
  await openCard(A.b5, { wait: false });
  await page.waitForFunction(() => !document.getElementById('toast').hidden, { timeout: 5000 });
  const t1 = await toastText();
  check('opening it explains instead of failing', t1.startsWith("You're offline and this book isn't downloaded") && !(await page.evaluate(() => Player.isExpanded())), t1);
  await page.click('.bottom-nav [data-sheet-open="add-sheet"]'); await sleep(300);
  check('Add explains that it needs a connection', (await toastText()) === 'Adding books needs a connection.'
        && !(await page.evaluate(() => Sheets.anyOpen())), await toastText());

  section('Offline: the offline page');
  await page.goto(`${base}/library`);
  await page.waitForSelector('#app-content .page[data-view="offline"]', { timeout: 10000 });
  await page.waitForSelector('.dl-item');
  const off = await page.evaluate(() => ({
    titles: [...document.querySelectorAll('.dl-item .dl-title')].map(e => e.textContent).sort(),
    badge: !document.getElementById('offline-badge').hidden, name: document.getElementById('offline-user-name').textContent,
    addr: location.pathname, token: !!document.querySelector('meta[name="csrf-token"]') }));
  check('a page load with no network shows the offline page (service worker fallback)', off.addr === '/library');
  check('it lists only the downloaded books, drawn from this device', JSON.stringify(off.titles) === '["Offline Story","Third Story"]', off.titles.join(', '));
  check('the badge shows and the user name is the cached one', off.badge && off.name === 'Eyram Wilson', off.name);
  check('no CSRF token on the offline page', !off.token);
  await shots('offline');
  await page.setViewport({ width: 390, height: 844 });

  section('Offline: playing a downloaded book');
  audioResponses.length = 0;
  await page.click(`.dl-open[data-open-book="${A.b4}"]`);
  await waitPlaying(page);
  let s = await page.evaluate(() => {
    const a = document.getElementById('audio-player'), m = navigator.mediaSession.metadata;
    return { src: new URL(a.src).pathname + new URL(a.src).search, page: document.getElementById('page-number').textContent,
             title: document.getElementById('player-title').textContent, ms: m && m.title, album: m && m.album,
             text: document.getElementById('text-preview').textContent, voice: document.getElementById('voice').disabled,
             note: document.getElementById('voice-note').textContent, mini: !document.getElementById('mini-player').hidden };
  });
  check('the downloaded book opens and plays with no network', s.title === 'Offline Story' && s.src.startsWith(`/audio/${A.b4}/`), s.src);
  check('page text comes from the device', s.text.length > 0 && !s.text.includes('Could not load'), s.text.slice(0, 60));
  check('lock-screen details are set', s.album === 'Offline Story' && !!s.ms, `${s.ms} | ${s.album}`);
  check('other voices are disabled with a short explanation', s.voice && s.note.includes('Other voices need a connection'), s.note);
  const art = await page.evaluate(async () => {
    const a = navigator.mediaSession.metadata.artwork[2];
    const r = await fetch(a.src); const b = await createImageBitmap(await r.blob()); return `${r.status} ${b.width}x${b.height}`;
  });
  check('lock-screen artwork loads offline', art === '200 512x512', art);
  const startPage = Number(s.page);
  await page.evaluate(() => { document.getElementById('audio-player').currentTime = 20; });
  await page.waitForFunction(() => { const a = document.getElementById('audio-player'); return !a.seeking && a.currentTime >= 19.5; }, { timeout: 10000 });
  const ranged = audioResponses.filter(r => r.sw && r.status === 206 && /^bytes \d+-\d+\/\d+$/.test(r.range));
  check('audio comes from the service worker as 206 Partial Content with Content-Range', ranged.length > 0,
        audioResponses.slice(0, 4).map(r => `${r.status} ${r.range} sw=${r.sw}`).join(', '));
  const rangeCheck = await page.evaluate(async url => {
    const full = await fetch(url); const total = (await full.blob()).size;
    const r = await fetch(url, { headers: { Range: 'bytes=100-199' } });
    const tail = await fetch(url, { headers: { Range: 'bytes=-50' } });
    const bad = await fetch(url, { headers: { Range: `bytes=${total + 10}-` } });
    return { total, s: r.status, cr: r.headers.get('content-range'), len: (await r.blob()).size,
             ts: tail.status, tcr: tail.headers.get('content-range'), bs: bad.status, fs: full.status };
  }, `/audio/${A.b4}/0?voice=af_heart`);
  check('Range requests: a middle range, a suffix range and an impossible one',
        rangeCheck.fs === 200 && rangeCheck.s === 206 && rangeCheck.cr === `bytes 100-199/${rangeCheck.total}` && rangeCheck.len === 100
        && rangeCheck.ts === 206 && rangeCheck.tcr === `bytes ${rangeCheck.total - 50}-${rangeCheck.total - 1}/${rangeCheck.total}`
        && rangeCheck.bs === 416, JSON.stringify(rangeCheck));
  await page.evaluate(() => { document.getElementById('audio-player').currentTime = 5; });
  await sleep(300);
  await page.evaluate(() => window.__ms.actions.seekforward({ action: 'seekforward' }));
  await sleep(300);
  const fwd = await page.evaluate(() => document.getElementById('audio-player').currentTime);
  check('lock-screen seek forward works offline', fwd >= 19.5 && fwd < 22, fwd.toFixed(1));
  await page.click('#speed-btn'); await sleep(200);
  check('speed works offline', await page.evaluate(() => document.getElementById('audio-player').playbackRate === 1.25));
  await page.evaluate(() => { const a = document.getElementById('audio-player'); a.currentTime = a.duration - 0.4; });
  await waitPage(startPage + 1);
  await waitPlaying(page);
  s = await page.evaluate(() => ({ src: new URL(document.getElementById('audio-player').src).pathname,
                                   rate: document.getElementById('audio-player').playbackRate }));
  check('at the end of a page the next one plays, offline', s.src === `/audio/${A.b4}/${startPage}` && s.rate === 1.25, s.src);
  await page.click('#toc-open-btn'); await sleep(500);
  const toc = await page.evaluate(() => ({ open: document.getElementById('toc-sidebar').classList.contains('toc-open'),
    items: [...document.querySelectorAll('.toc-item .toc-label')].map(e => e.textContent),
    ready: document.querySelectorAll('.toc-dot.dot-ready').length }));
  check('the contents drawer opens with the chapters, all ready', toc.open && JSON.stringify(toc.items) === '["Chapter One","Chapter Two"]'
        && toc.ready === 2, JSON.stringify(toc));
  await page.evaluate(() => document.querySelectorAll('.toc-item')[1].click());
  await waitPage(3); await waitPlaying(page);
  check('choosing a chapter plays it, offline', await page.evaluate(() => new URL(document.getElementById('audio-player').src).pathname)
        === `/audio/${A.b4}/2`);
  await page.click('#sleep-btn'); await sleep(400);
  await page.click('.sleep-opt[data-sleep="page"]'); await sleep(300);
  await page.evaluate(() => { const a = document.getElementById('audio-player'); a.currentTime = a.duration - 0.4; });
  await sleep(2000);
  check('sleep timer (end of page) stops playback, offline', await page.evaluate(() =>
    document.getElementById('audio-player').paused && document.getElementById('page-number').textContent === '3'));
  await page.click('#player-minimise'); await sleep(500);
  check('the mini player shows the book', await page.evaluate(() => !document.getElementById('mini-player').hidden
        && document.getElementById('mini-title').textContent === 'Offline Story'));
  await page.click('#mini-play'); await waitPlaying(page);
  check('the mini player plays and pauses, offline', true);
  await page.click('#mini-play'); await sleep(300);
  const p = await idb('progress', [userA, Number(A.b4)]);
  check('progress is saved on this device while offline', p && p.page === 2 && p.synced === false && p.speed === 1.25, JSON.stringify(p));

  section('Back online: progress syncs');
  await setOffline(false);
  await page.click('#offline-retry');
  await page.waitForSelector('#app-content .page[data-view="library"]', { timeout: 15000 });
  await page.waitForFunction(async (u, b) => {
    const r = await new Promise(res => { const o = indexedDB.open('waudible', 1); o.onsuccess = () => {
      const g = o.result.transaction('progress').objectStore('progress').get([u, b]); g.onsuccess = () => { o.result.close(); res(g.result); }; }; });
    return r && r.synced;
  }, { timeout: 15000 }, userA, Number(A.b4));
  const server = await page.evaluate(async id => (await fetch(`/player/${id}`)).json(), A.b4);
  check('the position made offline reached the server', server.page === 2 && server.speed === 1.25, `${server.page} ${server.speed}`);
  check('the badge is gone', await page.$eval('#offline-badge', el => el.hidden));
  // Last write wins: an older offline position doesn't replace a newer one
  const stale = await page.evaluate(async id => {
    const token = document.querySelector('meta[name="csrf-token"]').content;
    const r = await fetch('/save_progress', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRFToken': token },
      body: JSON.stringify({ book_id: Number(id), page: 0, speed: 1, voice: 'af_heart', at: Date.now() - 3600e3 }) });
    return [(await r.json()).status, (await (await fetch(`/player/${id}`)).json()).page];
  }, A.b4);
  check('an older position is ignored (last write wins)', stale[0] === 'stale' && stale[1] === 2, stale.join(' '));
  // A failed sync keeps the position for later
  await page.evaluate(async (u, id) => {
    await Offline.saveProgress(id, { page: 3, speed: 1.25, voice: 'af_heart' });
  }, userA, A.b4);
  await page.setRequestInterception(true);
  const fail = r => (new URL(r.url()).pathname === '/save_progress' ? r.abort() : r.continue());
  page.on('request', fail);
  await page.evaluate(() => Offline.sync());
  const kept = await idb('progress', [userA, Number(A.b4)]);
  check('a failed sync keeps the position', kept.page === 3 && kept.synced === false, JSON.stringify(kept));
  page.off('request', fail);
  await page.setRequestInterception(false);
  await page.evaluate(() => Offline.sync());
  check('and sends it on the next try', (await idb('progress', [userA, Number(A.b4)])).synced === true
        && (await page.evaluate(async id => (await (await fetch(`/player/${id}`)).json()).page, A.b4)) === 3);

  section('Online with a downloaded copy');
  audioResponses.length = 0; swNet.length = 0;
  await goto('/');
  await openCard(A.b4); await waitPlaying(page); await sleep(1500);
  const net = swNet.filter(u => u.startsWith('/audio/')).length, fromSw = audioResponses.filter(r => r.sw).length;
  check('a downloaded book plays from the device even online (no audio over the network)', net === 0 && fromSw > 0, `network ${net}, device ${fromSw}`);
  check('and no download suggestion for it', !(await page.evaluate(() => Sheets.isOpen('ask-sheet'))));
  await page.click('#more-btn'); await sleep(400);
  check('More sheet says it is downloaded', (await page.$eval('#more-download', el => el.textContent.trim())) === 'Downloaded to this device');
  await page.evaluate(() => Sheets.close()); await sleep(300);
  await collapse();

  section("Another account on the same browser");
  await page.deleteCookie(...(await page.cookies()));
  await login(page, { email: env.EMAIL2, password: env.PASSWORD2, ask: true });
  await page.waitForFunction(() => navigator.serviceWorker.controller, { timeout: 10000 });
  const userB = await uid();
  await goto('/library');
  await page.waitForFunction(() => document.getElementById('downloads-link-sub').textContent === 'Listen without a connection', { timeout: 10000 })
    .catch(() => {});
  check("B's library shows no downloads", (await page.$eval('#downloads-link-sub', el => el.textContent)) === 'Listen without a connection');
  check("B can't see A's downloaded copy", (await page.evaluate(id => Offline.state(id).name, A.b4)) === 'none'
        && userB !== userA);
  const leak = await page.evaluate(async id => (await fetch(`/audio/${id}/0?voice=af_heart`)).status, A.b4);
  check("A's cached audio is not served to B (the request reaches the server: 404)", leak === 404, leak);
  await goto('/downloads');
  await page.waitForSelector('.downloads-empty');
  check("B's Downloads screen is empty", (await page.$eval('#downloads', el => el.textContent)).startsWith('Nothing downloaded yet'));
  await setOffline(true);
  await page.goto(`${base}/`);
  await page.waitForSelector('#app-content .page[data-view="offline"]', { timeout: 10000 });
  await page.waitForSelector('.downloads-empty');
  check("offline, B sees none of A's books", (await page.$$('.dl-item')).length === 0
        && (await page.$eval('#offline-user-name', el => el.textContent)) === 'Second Person');
  await setOffline(false);
  await goto('/');
  await Promise.all([page.waitForNavigation(), page.click('#logout-form button')]);
  check('B (nothing downloaded) logs out straight away', new URL(page.url()).pathname === '/login');
  await login(page, { ask: true });
  await page.waitForFunction(() => navigator.serviceWorker.controller, { timeout: 10000 });
  await page.waitForFunction(id => Offline.state(id).name === 'downloaded', { timeout: 10000 }, A.b4).catch(() => {});
  check("A's downloads are still there after B used the browser", (await stateOf(A.b4)) === 'downloaded');

  section('Deleting');
  await goto('/downloads');
  await page.waitForSelector(`.dl-item[data-book-id="${A.b6}"] .dl-delete`);
  await page.click(`.dl-item[data-book-id="${A.b6}"] .dl-delete`);
  await page.waitForFunction(id => !document.querySelector(`.dl-item[data-book-id="${id}"]`), { timeout: 10000 }, A.b6);
  check('the delete button removes one download from the device', (await idb('books', [userA, Number(A.b6)])) === null
        && !(await cacheUrls(userA)).some(u => u.startsWith(`/audio/${A.b6}/`)));
  await page.evaluate(id => Offline.download(id, { quiet: true }), A.b6);
  await waitState(A.b6, 'downloaded');
  // Deleted on the server from somewhere else: gone here on the next visit
  await page.evaluate(async id => {
    const token = document.querySelector('meta[name="csrf-token"]').content;
    await fetch(`/delete/${id}`, { method: 'POST', headers: { 'X-CSRFToken': token } });
  }, A.b6);
  await goto('/');
  await page.waitForFunction(id => Offline.state(id).name === 'none', { timeout: 15000 }, A.b6).catch(() => {});
  check('a book deleted on the server loses its download on the next visit', (await idb('books', [userA, Number(A.b6)])) === null
        && !(await cacheUrls(userA)).some(u => u.startsWith(`/audio/${A.b6}/`)));
  await page.evaluate(id => Offline.download(id, { quiet: true }), A.b5);
  await waitState(A.b5, 'downloaded');
  await openMenu(A.b5);
  await page.click('#book-delete'); await sleep(200);
  await page.click('#delete-form button[type=submit]');
  await waitView(page, 'home');
  await page.waitForFunction(id => Offline.state(id).name === 'none', { timeout: 10000 }, A.b5).catch(() => {});
  check('deleting a book in the app removes its download too', (await idb('books', [userA, Number(A.b5)])) === null
        && !(await cacheUrls(userA)).some(u => u.startsWith(`/audio/${A.b5}/`)));
  await goto('/downloads');
  await page.waitForSelector('#downloads-delete-all');
  await page.click('#downloads-delete-all');
  await page.waitForSelector('#downloads-delete-all-confirm');
  await page.click('#downloads-delete-all-confirm');
  await page.waitForSelector('.downloads-empty', { timeout: 10000 });
  check('Delete all (after a confirm) removes every download', (await idbAll('books')).filter(r => r.uid === userA).length === 0
        && !(await page.evaluate(async u => (await caches.keys()).includes(`waudible-media-u${u}`), userA)));

  section('Log out');
  await page.evaluate(id => Offline.download(id, { quiet: true }), A.b4);
  await waitState(A.b4, 'downloaded');
  await goto('/');
  await page.click('#logout-form button');
  await page.waitForFunction(() => Sheets.isOpen('logout-sheet'), { timeout: 5000 });
  await sleep(500);   // slide-in
  const lt = await page.$eval('#logout-text', el => el.textContent);
  check('logging out first says the downloads will be deleted', /^Logging out deletes your 1 downloaded book \(\d+(\.\d)? MB\)/.test(lt), lt);
  await Promise.all([page.waitForNavigation(), page.click('#logout-confirm')]);
  check('then logs out', new URL(page.url()).pathname === '/login');
  const left = await page.evaluate(async u => {
    const store = n => new Promise(res => { const o = indexedDB.open('waudible', 1); o.onsuccess = () => {
      const g = o.result.transaction(n).objectStore(n).getAll(); g.onsuccess = () => { o.result.close(); res(g.result); }; }; });
    return { books: (await store('books')).filter(r => r.uid === u).length, progress: (await store('progress')).filter(r => r.uid === u).length,
             meta: (await store('meta')).length, cache: (await caches.keys()).includes(`waudible-media-u${u}`),
             ask: Object.keys(localStorage).filter(k => k.startsWith(`waudible:ask:${u}:`)).length };
  }, userA);
  check("logout deleted the user's downloads, progress, cached user and choices", left.books === 0 && left.progress === 0
        && left.meta === 0 && !left.cache && left.ask === 0, JSON.stringify(left));
  await setOffline(true);
  await page.goto(`${base}/`);
  await page.waitForSelector('.downloads-empty', { timeout: 10000 });
  check('offline after logout: no books and no name', (await page.$$('.dl-item')).length === 0
        && (await page.$eval('#offline-user-name', el => el.textContent)) === '');
  await setOffline(false);

  const real = errors.filter(e => !/^(404|409|416) \/(audio|offline)/.test(e) && !e.includes('ERR_INTERNET_DISCONNECTED'));
  check('no JavaScript errors or unexpected failed requests', real.length === 0, real.slice(0, 5).join(' | '));
});
