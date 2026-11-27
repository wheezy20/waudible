// After a deploy: the installed app must never mix the new pages with the
// old CSS and JS, the new service worker takes over in one reload, and a
// page left open is offered the update ("Update available, tap to
// refresh"), reloading by itself when nothing is playing and nobody is
// using it. server.py serves the static files from a copy and changes them
// on GET /__test__/deploy, as a real deploy and restart would.
const path = require('path');
const { base, env, books: { b1 }, sleep, check, section, login, waitPlaying, watchErrors, run } = require('./common');

run(async browser => {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844 });
  const errors = watchErrors(page);
  let assets = [];
  page.on('response', r => {
    const u = new URL(r.url());
    if (/^\/static\/.*\.(css|js)$/.test(u.pathname)) assets.push({ path: u.pathname, v: u.searchParams.get('v'), sw: r.fromServiceWorker() });
  });

  // The deploy is asked for outside the page, so the page doesn't learn of it from the reply
  async function deploy() {
    const cookie = (await page.cookies()).map(c => `${c.name}=${c.value}`).join('; ');
    const r = await fetch(`${base}/__test__/deploy`, { headers: { cookie } });
    return r.json();
  }
  const build = () => page.$eval('meta[name="waudible-build"]', m => m.content);
  const workerVersion = () => page.evaluate(() => new Promise(resolve => {
    const c = navigator.serviceWorker.controller;
    if (!c) return resolve(null);
    const ch = new MessageChannel();
    ch.port1.onmessage = e => resolve(e.data.version);
    c.postMessage({ type: 'version' }, [ch.port2]);
  }));
  const looks = () => page.evaluate(() => ({
    css: getComputedStyle(document.documentElement).getPropertyValue('--test-build').trim(),
    js: window.__testBuild || 0,
    grid: getComputedStyle(document.querySelector('.voice-options')).display,
    bar: !document.getElementById('update-bar').hidden,
  }));
  const shellCaches = () => page.evaluate(async () => (await caches.keys()).filter(n => n.startsWith('waudible-shell-')));

  await login(page);
  await page.waitForFunction(() => navigator.serviceWorker.controller, { timeout: 20000 });
  await sleep(1000);

  section('One build for the page, its assets and the service worker');
  const b0 = await build();
  check('the page says which build it is', /^[0-9a-f]{12}$/.test(b0), b0);
  check('the service worker is the same build', await workerVersion() === b0);
  check('its cache is named after the build, and is the only one', JSON.stringify(await shellCaches()) === JSON.stringify([`waudible-shell-${b0}`]),
        (await shellCaches()).join(', '));
  const keys = await page.evaluate(async n => (await (await caches.open(n)).keys()).map(r => { const u = new URL(r.url); return u.pathname + u.search; }), `waudible-shell-${b0}`);
  check('it holds the CSS and scripts under their versioned URLs', [`/static/css/style.css?v=${b0}`, `/static/js/player.js?v=${b0}`,
        `/static/js/update.js?v=${b0}`, '/offline'].every(k => keys.includes(k)), keys.join(' '));
  assets = [];
  await page.reload(); await page.waitForFunction(() => window.Player && window.Update); await sleep(500);
  check('on a reload the CSS and scripts come from that cache', assets.length >= 6 && assets.every(a => a.sw && a.v === b0),
        assets.map(a => `${a.path}?v=${a.v} ${a.sw ? 'sw' : 'net'}`).join(', '));
  check('no update offered while nothing changed', !(await looks()).bar);

  section('A deploy, then the app is opened again (the bug from the phone)');
  const d1 = await deploy();
  check('the test server now runs a new build', d1.build !== b0, `${b0} -> ${d1.build}`);
  assets = [];
  await page.reload(); await page.waitForFunction(() => window.Player && window.Update); await sleep(800);
  let l = await looks();
  check('the new page is the new build', await build() === d1.build);
  check('its CSS and every script are the new build\'s files (from the network, not the old cache)',
        assets.length >= 6 && assets.every(a => a.v === d1.build && !a.sw), assets.map(a => `${a.path}?v=${a.v} ${a.sw ? 'sw' : 'net'}`).join(', '));
  check('the new CSS is in use', l.css === '"1"', l.css);
  check('the new JS is in use', l.js === 1, l.js);
  check('the voice picker is laid out as a grid', l.grid === 'grid', l.grid);
  await page.waitForFunction(async v => {
    const c = navigator.serviceWorker.controller; if (!c) return false;
    const ch = new MessageChannel();
    const got = new Promise(r => { ch.port1.onmessage = e => r(e.data.version); setTimeout(() => r(null), 1000); });
    c.postMessage({ type: 'version' }, [ch.port2]);
    return (await got) === v;
  }, { timeout: 20000, polling: 500 }, d1.build);
  check('the new service worker took over without a second restart', await workerVersion() === d1.build);
  const t = Date.now();
  await page.waitForFunction(async n => JSON.stringify((await caches.keys()).filter(k => k.startsWith('waudible-shell-'))) === JSON.stringify([n]),
                             { timeout: 15000, polling: 250 }, `waudible-shell-${d1.build}`).catch(() => {});
  console.log(`   (old cache gone after ${Date.now() - t} ms)`);
  check('and dropped the old build\'s cache', JSON.stringify(await shellCaches()) === JSON.stringify([`waudible-shell-${d1.build}`]),
        (await shellCaches()).join(', '));
  check('the update bar stays hidden (this page is already the new build)', !(await looks()).bar);
  assets = [];
  await page.reload(); await page.waitForFunction(() => window.Player && window.Update); await sleep(500);
  check('the next open takes the new files from the new cache', assets.length >= 6 && assets.every(a => a.sw && a.v === d1.build));

  section('A page left open across a deploy: playing, so it only offers the update');
  await page.evaluate(id => Player.open(id), b1);
  await waitPlaying(page);
  await page.evaluate(() => Player.collapse()); await sleep(400);
  await page.evaluate(() => { Update.idleMs = 1000; });
  const d2 = await deploy();
  await page.evaluate(() => Update.check());       // what returning to the app does
  await page.waitForFunction(() => !document.getElementById('update-bar').hidden, { timeout: 20000 });
  l = await looks();
  check('the new worker taking over shows "Update available, tap to refresh"', l.bar
        && (await page.$eval('#update-btn', b => b.textContent.trim())) === 'Update available, tap to refresh');
  check('the page knows which build is waiting', await page.evaluate(() => Update.newer()) === d2.build);
  await page.screenshot({ path: path.join(env.SHOT_DIR, 'update-bar-390x844.png') });
  await sleep(6500);
  check('no reload while audio plays, even with no input', await build() === d1.build
        && await page.evaluate(() => !document.getElementById('audio-player').paused));
  // A boosted navigation while playing still swaps (the audio carries on)
  await page.click('.bottom-nav a[data-nav="library"]');
  await page.waitForFunction(() => document.querySelector('#app-content .page') && document.querySelector('#app-content .page').dataset.view === 'library', { timeout: 15000 });
  check('a page change while playing keeps the audio going', await build() === d1.build
        && await page.evaluate(() => !document.getElementById('audio-player').paused));

  section('Nothing playing and nobody using it: it reloads by itself');
  await page.evaluate(() => document.getElementById('audio-player').pause());
  await page.waitForFunction(b => document.querySelector('meta[name="waudible-build"]')
                             && document.querySelector('meta[name="waudible-build"]').content === b, { timeout: 30000, polling: 500 }, d2.build);
  await page.waitForFunction(() => window.Update); await sleep(500);
  l = await looks();
  check('the page reloaded into the new build, with its CSS and JS', await build() === d2.build && l.css === '"2"' && l.js === 2, `${l.css} ${l.js}`);
  check('the bar is gone after the reload', !l.bar);
  check('the progress was kept', (await page.evaluate(async id => (await (await fetch(`/player/${id}`)).json()).page, b1)) === 14);

  section('Not idle: an open sheet holds the reload back, a tap on the bar reloads');
  await page.evaluate(() => { Update.idleMs = 1000; Sheets.open('add-sheet'); });
  const d3 = await deploy();
  await page.evaluate(() => fetch('/offline/books'));   // any reply from the server says which build it is
  await page.waitForFunction(() => !document.getElementById('update-bar').hidden, { timeout: 10000 });
  check('a JSON reply from the new build shows the bar', true);
  await sleep(6500);
  check('no reload while a sheet is open', await build() === d2.build);
  // Long idle time first, so closing the sheet doesn't let it reload by itself before the tap
  await page.evaluate(() => { Update.idleMs = 3600 * 1000; Sheets.close(); }); await sleep(300);
  await Promise.all([page.waitForNavigation({ timeout: 15000 }), page.click('#update-btn')]);
  await page.waitForFunction(() => window.Update); await sleep(300);
  check('tapping the bar loads the new build', await build() === d3.build);

  section('A link followed after a deploy, with nothing playing: a full page load, not a swap');
  const d4 = await deploy();
  await page.click('.bottom-nav a[data-nav="home"]');
  await page.waitForFunction(b => document.querySelector('meta[name="waudible-build"]').content === b, { timeout: 15000, polling: 300 }, d4.build);
  await page.waitForFunction(() => window.Update); await sleep(300);
  l = await looks();
  check('Home opens as the new build with its own CSS and JS', l.css === '"4"' && l.js === 4 && new URL(page.url()).pathname === '/', `${l.css} ${l.js} ${page.url()}`);

  check('no JavaScript errors or failed requests', errors.length === 0, errors.slice(0, 5).join(' | '));
});
