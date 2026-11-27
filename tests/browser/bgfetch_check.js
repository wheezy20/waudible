// Downloads that don't depend on the page staying open.
// 1. Background Fetch (Chromium, the installed app on Android): the
//    browser downloads, sw.js stores the files with the same size checks,
//    per-account cache and IndexedDB records as the app's own loop; a file
//    that fails its check stays pending and the next attempt fetches only
//    that; cancelling drops what the download was adding.
// 2. The app's own loop (where there is no Background Fetch): at most 3
//    files at once, the screen kept on, a clean pause in the background
//    that carries on by itself, and a resume after the connection drops.
const { base, env, sleep, check, section, login, waitPlaying, watchErrors, run } = require('./common');

const B = { b4: env.BOOK4, b5: env.BOOK5, b6: env.BOOK6, b8: env.BOOK8 };

// Records what the app hands to Background Fetch, and can abort a fetch
// the moment it starts (as if the notification's Cancel were tapped)
const BG_SPY = () => {
  window.__bg = { calls: [], abortNext: false };
  if (!window.BackgroundFetchManager) return;
  const real = BackgroundFetchManager.prototype.fetch;
  BackgroundFetchManager.prototype.fetch = async function (id, requests, options) {
    window.__bg.calls.push({ id, urls: requests.map(r => (typeof r === 'string' ? r : r.url)), total: options && options.downloadTotal });
    const reg = await real.call(this, id, requests, options);
    if (window.__bg.abortNext) { window.__bg.abortNext = false; await reg.abort(); }
    return reg;
  };
};

// Wake Lock calls, and a way to pretend the app went to the background
const LOOP_SPY = () => {
  window.__waudibleNoBackgroundFetch = true;
  window.__wake = { requested: 0, released: 0 };
  const fake = { request: async () => { window.__wake.requested++;
    return { release: async () => { window.__wake.released++; }, addEventListener() {} }; } };
  try { Object.defineProperty(navigator, 'wakeLock', { value: fake, configurable: true }); } catch (e) { /* keep the real one */ }
  let vis = 'visible';
  Object.defineProperty(document, 'visibilityState', { get: () => vis, configurable: true });
  Object.defineProperty(document, 'hidden', { get: () => vis === 'hidden', configurable: true });
  window.__setVisible = v => { vis = v ? 'visible' : 'hidden'; document.dispatchEvent(new Event('visibilitychange')); };
};

function helpers(page) {
  const idb = (store, key) => page.evaluate((store, key) => new Promise(res => {
    const r = indexedDB.open('waudible', 1);
    r.onsuccess = () => {
      const g = r.result.transaction(store, 'readonly').objectStore(store).get(key);
      g.onsuccess = () => { r.result.close(); res(g.result || null); };
    };
  }), store, key);
  const cached = (u, id) => page.evaluate(async (u, id) => {
    const c = await caches.open(`waudible-media-u${u}`);
    const out = {};
    for (const r of await c.keys()) {
      const x = new URL(r.url);
      if (x.pathname.startsWith(`/audio/${id}/`) || x.pathname === `/cover/${id}`) out[x.pathname + x.search] = Number((await c.match(r)).headers.get('Content-Length'));
    }
    return out;
  }, u, id);
  const manifest = id => page.evaluate(async id => (await fetch(`/offline/manifest/${id}?texts=0`)).json(), id);
  const waitState = (id, name, timeout = 60000) =>
    page.waitForFunction((id, n) => Offline.state(id).name === n, { timeout, polling: 100 }, id, name);
  const neverAsk = () => page.evaluate(ids => {
    const u = document.querySelector('meta[name="waudible-user"]').content;
    for (const id of ids) localStorage.setItem(`waudible:ask:${u}:${id}`, JSON.stringify({ choice: 'never', at: Date.now() }));
  }, Object.values(B));
  return { idb, cached, manifest, waitState, neverAsk };
}

run(async browser => {
  section('Background Fetch: the browser downloads, the service worker stores');
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.evaluateOnNewDocument(BG_SPY);
  const errors = watchErrors(page);
  const pageAudio = [];
  page.on('request', r => { if (new URL(r.url()).pathname.startsWith('/audio/')) pageAudio.push(new URL(r.url()).pathname); });
  const messages = [];
  await page.exposeFunction('__swMessage', m => messages.push(m));
  await page.evaluateOnNewDocument(() => navigator.serviceWorker && navigator.serviceWorker.addEventListener('message', e => window.__swMessage(e.data)));
  await login(page);
  const h = helpers(page);
  // Chrome's download limiter allows one automatic download per page load
  // (as when the app is opened), so each check starts from a fresh load
  const fresh = async () => {
    await page.goto(`${base}/library`);
    await page.waitForFunction(() => window.Offline && navigator.serviceWorker.controller, { timeout: 20000 });
    await page.evaluate(() => Offline.ready);
  };
  // Starts a download the way a tap does, and waits for it to end
  const pageCdp = await page.target().createCDPSession();
  const tapDownload = async (id, before = null) => {
    await fresh();
    if (before) await page.evaluate(before);
    await pageCdp.send('Runtime.evaluate', { expression: `window.__dl = Offline.download(${Number(id)}, { quiet: true })`, userGesture: true });
    return page.evaluate(async id => { await window.__dl; return Offline.state(id).name; }, id);
  };
  await h.neverAsk();
  await page.waitForFunction(() => navigator.serviceWorker.controller, { timeout: 20000 });
  const u = await page.evaluate(() => Offline.user());
  const supported = await page.evaluate(async () => !!(await navigator.serviceWorker.ready).backgroundFetch);
  check('this Chrome has Background Fetch', supported);

  pageAudio.length = 0;
  await pageCdp.send('Runtime.evaluate', { expression: `Offline.download(${Number(B.b4)}, { quiet: true })`, userGesture: true });
  await page.waitForFunction(id => Offline.state(id).background, { timeout: 15000 }, B.b4);
  const ids = await page.evaluate(async () => (await navigator.serviceWorker.ready).backgroundFetch.getIds());
  check('the download is handed to the browser under this account and book', ids.includes(`waudible:${u}:${B.b4}`), ids.join(', '));
  const call = (await page.evaluate(() => window.__bg.calls))[0];
  const man4 = await h.manifest(B.b4);
  check('with every file and the exact total size', call && call.urls.length === man4.files.length
        && call.total === man4.files.reduce((n, f) => n + f.bytes, 0), call && `${call.urls.length} files, ${call.total} bytes`);
  await h.waitState(B.b4, 'downloaded');
  const rec4 = await h.idb('books', [u, Number(B.b4)]);
  check('the service worker updated the book record: every page here, nothing pending, artwork here',
        rec4 && JSON.stringify(rec4.have) === '[0,1,2,3]' && rec4.pending.length === 0 && rec4.complete && rec4.art, rec4 && JSON.stringify(rec4.have));
  const c4 = await h.cached(u, B.b4);
  check('every file is in this account\'s cache at the size the server gave', man4.files.every(f => c4[f.url] === f.bytes),
        Object.keys(c4).length);
  check('the page itself fetched no audio (the browser did)', pageAudio.length === 0, pageAudio.join(', '));
  check('the service worker told the page when it had stored the files', messages.some(m => m.type === 'bgfetch' && m.book === Number(B.b4)
        && m.outcome === 'success' && m.stored === man4.files.length), JSON.stringify(messages));
  await page.setOfflineMode(true);
  await page.waitForFunction(() => !Offline.isOnline(), { timeout: 10000 });
  await page.evaluate(id => Player.open(id), B.b4);
  await waitPlaying(page);
  check('the book plays offline from what the service worker stored', await page.evaluate(() => !document.getElementById('audio-player').paused));
  await page.evaluate(() => { document.getElementById('audio-player').pause(); Player.collapse(); });
  await page.setOfflineMode(false);
  await page.waitForFunction(() => Offline.isOnline(), { timeout: 10000 });

  section('Background Fetch: a file that fails its size check stays pending, and only it is fetched again');
  await page.setRequestInterception(true);
  const lie = async r => {
    const url = new URL(r.url());
    if (url.pathname === `/offline/manifest/${B.b5}` && !url.search.includes('texts=0')) {
      const real = await (await fetch(`${base}${url.pathname}`, { headers: { cookie: (await page.cookies()).map(c => `${c.name}=${c.value}`).join('; ') } })).json();
      real.files.find(f => f.kind === 'audio' && f.page === 1).bytes += 1;      // the server "promised" one byte more
      r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(real) });
    } else r.continue();
  };
  page.on('request', lie);
  const r5 = await tapDownload(B.b5);
  page.off('request', lie);
  await page.setRequestInterception(false);
  const rec5 = await h.idb('books', [u, Number(B.b5)]);
  const man5 = await h.manifest(B.b5);
  const c5 = await h.cached(u, B.b5);
  check('the other pages are kept, page 2 stays pending (state "partial")', r5 === 'partial' && rec5
        && JSON.stringify(rec5.have) === '[0,2]' && JSON.stringify(rec5.pending) === '[1]', `${r5} ${rec5 && JSON.stringify([rec5.have, rec5.pending])}`);
  check('the file that failed its check is not in the cache', !(man5.files.find(f => f.page === 1).url in c5));
  const toast5 = await page.evaluate(() => document.getElementById('toast').textContent);
  check('the listener is told it carries on later', /carries on next time you open WAudible/.test(toast5), toast5);
  await page.evaluate(() => { window.__bg.calls.length = 0; });
  await tapDownload(B.b5);
  await h.waitState(B.b5, 'downloaded');
  const again = await page.evaluate(() => window.__bg.calls);
  check('resuming hands only the missing page to the browser', again.length === 1 && JSON.stringify(again[0].urls)
        === JSON.stringify([man5.files.find(f => f.page === 1).url]), JSON.stringify(again.map(c => c.urls)));
  const rec5b = await h.idb('books', [u, Number(B.b5)]);
  check('and the book is complete', rec5b.complete && JSON.stringify(rec5b.have) === '[0,1,2]');

  section('Background Fetch: cancelled from the notification');
  const cancelled = await tapDownload(B.b8, () => { window.__bg.abortNext = true; });
  await sleep(1500);
  check('the download ends with nothing kept for that book', cancelled === 'none' && (await h.idb('books', [u, Number(B.b8)])) === null
        && Object.keys(await h.cached(u, B.b8)).length === 0, cancelled);
  check('and no background download is left', (await page.evaluate(async () => (await navigator.serviceWorker.ready).backgroundFetch.getIds())).length === 0);

  section('Background Fetch refused by the browser: the app does it itself');
  // Chrome allows one automatic download per page load: the first goes to
  // the browser, a second one in the same page load is refused
  await tapDownload(B.b6);
  check('a first download in this page load goes to the browser', (await page.evaluate(() => window.__bg.calls.length)) >= 1
        && (await page.evaluate(id => Offline.state(id).name, B.b6)) === 'downloaded');
  pageAudio.length = 0;
  const refused = await page.evaluate(async id => { await Offline.download(id, { quiet: true }); return Offline.state(id).name; }, B.b8);
  check('a second one is refused by the browser, and the app\'s own loop completes it', refused === 'downloaded'
        && pageAudio.filter(x => x.startsWith(`/audio/${B.b8}/`)).length === 10, `${refused}, ${pageAudio.length} page fetches`);

  section('Background Fetch: Delete all stops it and keeps nothing');
  await fresh();
  await page.evaluate(id => Offline.remove(id), B.b5);
  await pageCdp.send('Runtime.evaluate', { expression: `Offline.download(${Number(B.b5)}, { quiet: true })`, userGesture: true });
  await page.waitForFunction(id => Offline.state(id).background || Offline.state(id).name === 'downloaded', { timeout: 15000 }, B.b5);
  const wasRunning = await page.evaluate(id => Offline.state(id).name === 'downloading', B.b5);
  await page.evaluate(() => Offline.removeAll());
  await sleep(1500);
  check('Delete all during a background download leaves no record, no cached file and no background download', wasRunning
        && (await h.idb('books', [u, Number(B.b5)])) === null && Object.keys(await h.cached(u, B.b5)).length === 0
        && (await page.evaluate(async () => (await navigator.serviceWorker.ready).backgroundFetch.getIds())).length === 0);
  check('no JavaScript errors or failed requests (Background Fetch)', errors.length === 0, errors.slice(0, 5).join(' | '));

  // ── 2. The app's own loop ──
  section("The app's own loop: three files at a time, the screen kept on");
  const ctx2 = await browser.createBrowserContext();
  const p2 = await ctx2.newPage();
  await p2.evaluateOnNewDocument(LOOP_SPY);
  const errors2 = watchErrors(p2);
  let inflight = 0, peak = 0;
  const started = [], finished = [];
  const live = new Set();
  p2.on('request', r => { if (new URL(r.url()).pathname.startsWith('/audio/') && r.resourceType() === 'fetch') {
    live.add(r); inflight++; peak = Math.max(peak, inflight); started.push(new URL(r.url()).pathname); } });
  const done = r => { if (live.delete(r)) { inflight--; if (r.response() && r.response().ok()) finished.push(new URL(r.url()).pathname); } };
  p2.on('requestfinished', done);
  p2.on('requestfailed', done);
  await login(p2);
  const h2 = helpers(p2);
  await h2.neverAsk();
  await p2.waitForFunction(() => navigator.serviceWorker.controller, { timeout: 20000 });
  const u2 = await p2.evaluate(() => Offline.user());
  // A slow link, so files overlap the way they do on a phone
  const cdp = await p2.target().createCDPSession();
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 300, downloadThroughput: 250 * 1024, uploadThroughput: 250 * 1024 });
  await p2.evaluate(id => Offline.download(id, { quiet: true }), B.b8);
  check('the loop is used where there is no Background Fetch', (await p2.evaluate(id => Offline.state(id).name, B.b8)) === 'downloaded');
  check('at most three files at once (and it does use three)', peak === 3, `peak ${peak}`);
  const w = await p2.evaluate(() => window.__wake);
  check('the screen is kept on while it runs, and let go afterwards', w.requested >= 1 && w.released === w.requested, JSON.stringify(w));
  const rec8 = await h2.idb('books', [u2, Number(B.b8)]);
  check('the book is stored as before', rec8.complete && rec8.have.length === 10 && rec8.art);

  section("The app's own loop: paused in the background, carries on when the app comes back");
  started.length = 0;
  const dl4 = p2.evaluate(id => Offline.download(id, { quiet: true }), B.b4);
  // After the 4 artwork files and at least one page
  await p2.waitForFunction(id => Offline.state(id).name === 'downloading' && Offline.state(id).job.done >= 5, { timeout: 30000, polling: 50 }, B.b4);
  await p2.evaluate(() => window.__setVisible(false));
  await sleep(400);
  const paused = await p2.evaluate(id => ({ s: Offline.state(id), text: (() => { const b = document.querySelector('[data-download-action]'); return b ? b.textContent : ''; })() }), B.b4);
  check('it pauses when the app goes to the background', paused.s.name === 'downloading' && paused.s.paused, JSON.stringify(paused.s.name));
  const before = started.length;
  await sleep(2500);
  check('no new files are fetched while paused', started.length === before, `${started.length - before} new`);
  const mid = await h2.idb('books', [u2, Number(B.b4)]);
  check('what it had is saved for resuming', mid && mid.pending.length > 0 && mid.have.length >= 1, mid && JSON.stringify([mid.have, mid.pending]));
  await p2.evaluate(() => window.__setVisible(true));
  await p2.waitForFunction(() => /Paused while the app was in the background\. Carrying on now\./.test(document.getElementById('toast').textContent), { timeout: 5000 });
  check('coming back says so ("Paused while the app was in the background. Carrying on now.")', true);
  await dl4;
  check('and it finishes by itself', (await p2.evaluate(id => Offline.state(id).name, B.b4)) === 'downloaded');
  const man4b = await h2.manifest(B.b4);
  const c4b = await h2.cached(u2, B.b4);
  check('every file complete at its size', man4b.files.every(f => c4b[f.url] === f.bytes));

  section("The app's own loop: the connection drops part way, then it resumes");
  // Offline for the page and for its service worker, which makes the
  // network requests for page audio itself
  const swSessions = new Map();
  const offline2 = async on => {
    await p2.setOfflineMode(on);
    for (const t of browser.targets().filter(t => t.type() === 'service_worker' && t.browserContext() === ctx2)) {
      if (!swSessions.has(t)) {
        const s = await t.createCDPSession();
        await s.send('Network.enable');
        swSessions.set(t, s);
      }
      await swSessions.get(t).send('Network.emulateNetworkConditions', { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    }
  };
  await p2.evaluate(id => Offline.remove(id), B.b8);
  finished.length = 0; started.length = 0;
  const dl6 = p2.evaluate(id => Offline.download(id, { quiet: true }), B.b8);
  // After the artwork and two pages, with eight pages to go
  await p2.waitForFunction(id => Offline.state(id).name === 'downloading' && Offline.state(id).job.done >= 6, { timeout: 30000, polling: 50 }, B.b8);
  await offline2(true);
  await dl6;
  const stopped = await p2.evaluate(id => ({ name: Offline.state(id).name, toast: document.getElementById('toast').textContent }), B.b8);
  check('the download stops and keeps what it had', stopped.name === 'partial' && /carries on when you are back online/.test(stopped.toast), JSON.stringify(stopped));
  // What was stored when it stopped (a file that had arrived but wasn't
  // stored yet is fetched again, which is right)
  const kept = Object.keys(await h2.cached(u2, B.b8)).filter(x => x.startsWith('/audio/')).map(x => x.split('?')[0]);
  finished.length = 0;
  await offline2(false);
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 300, downloadThroughput: 250 * 1024, uploadThroughput: 250 * 1024 });
  await h2.waitState(B.b8, 'downloaded', 60000);
  const twice = kept.filter(x => finished.includes(x));
  check('back online it carries on by itself, without fetching again what it had stored', kept.length >= 2 && twice.length === 0
        && finished.length === 10 - kept.length, `kept ${kept.length}, fetched ${finished.length}, again: ${twice.join(', ')}`);
  check('no JavaScript errors or failed requests (app loop)', errors2.filter(e => !/Failed to fetch|ERR_INTERNET_DISCONNECTED/.test(e)).length === 0,
        errors2.slice(0, 5).join(' | '));
});
