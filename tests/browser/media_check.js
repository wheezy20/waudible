// Lock screen and notification controls (Media Session), speed, page changes,
// preloading the next page and the sleep timer, on the persistent player.
const { base, books: { b1, b2, b3 }, sleep, check, section, login, waitPlaying, watchErrors, RECORDER, run } = require('./common');

run(async browser => {
  const page = await (await browser.createBrowserContext()).newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.evaluateOnNewDocument(RECORDER);
  const errors = watchErrors(page);
  const requests = [], saves = [];
  page.on('request', r => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/audio/')) requests.push({ path: u.pathname + u.search, type: r.resourceType() });
    if (u.pathname === '/save_progress') saves.push(JSON.parse(r.postData()));
  });

  const state = () => page.evaluate(() => {
    const a = document.getElementById('audio-player'), m = navigator.mediaSession.metadata;
    const src = a.getAttribute('src') ? new URL(a.src) : null;
    return { page: document.getElementById('page-number').textContent.trim(), src: src ? src.pathname + src.search : '',
             paused: a.paused, time: a.currentTime, duration: a.duration, rate: a.playbackRate, pitch: a.preservesPitch,
             playbackState: navigator.mediaSession.playbackState, title: m && m.title, album: m && m.album, artist: m && m.artist,
             artwork: m ? m.artwork.map(x => `${x.sizes} ${new URL(x.src).pathname}${new URL(x.src).search} ${x.type}`) : [] };
  });
  const lastPos = () => page.evaluate(() => window.__ms.positions[window.__ms.positions.length - 1]);
  const action = (name, details) => page.evaluate((n, d) => window.__ms.actions[n](d), name, details || { action: name });
  const seekTo = fraction => page.evaluate(f => { const a = document.getElementById('audio-player'); a.currentTime = a.duration * f; }, fraction);
  const waitPage = n => page.waitForFunction(n => document.getElementById('page-number').textContent.trim() === n, { timeout: 15000 }, String(n));

  await login(page);

  section('Lock-screen details');
  await page.click(`#library a[data-open-book="${b1}"]`);
  await waitPlaying(page);
  await page.waitForFunction(() => document.querySelectorAll('.toc-item').length > 0, { timeout: 15000 });
  await sleep(800);
  let s = await state();
  check('title is the chapter (page 15 is in "The Man Who Didn\'t Look Right")', s.title === "The Man Who Didn't Look Right", s.title);
  check('album is the book title', s.album === 'Atomic Habits: An Easy and Proven Way to Build Good Habits', s.album);
  check('artist is the author', s.artist === 'James Clear', s.artist);
  check('artwork at 96, 192 and 512 from the cover route', JSON.stringify(s.artwork) === JSON.stringify(
    [96, 192, 512].map(n => `${n}x${n} /cover/${b1}?size=${n} image/png`)), s.artwork.join(', '));
  const dims = await page.evaluate(async () => Promise.all(navigator.mediaSession.metadata.artwork.map(async a => {
    const r = await fetch(a.src); const bmp = await createImageBitmap(await r.blob());
    return `${r.status} ${r.headers.get('content-type')} ${bmp.width}x${bmp.height}`; })));
  check('each artwork loads as a square PNG of its size', JSON.stringify(dims) === JSON.stringify(
    ['200 image/png 96x96', '200 image/png 192x192', '200 image/png 512x512']), dims.join(', '));
  check('playbackState is "playing"', s.playbackState === 'playing', s.playbackState);
  const actions = await page.evaluate(() => Object.keys(window.__ms.actions).sort());
  check('all seven action handlers registered', JSON.stringify(actions) === JSON.stringify(
    ['nexttrack', 'pause', 'play', 'previoustrack', 'seekbackward', 'seekforward', 'seekto']), actions.join(', '));
  const pos = await lastPos();
  check('positionState has duration, position and rate', pos && Math.round(pos.duration) === 30 && pos.playbackRate === 1
        && pos.position >= 0 && pos.position <= pos.duration, JSON.stringify(pos));

  section('Preload the next page halfway through');
  requests.length = 0;   // first, before any seek has passed the halfway mark
  await seekTo(0.3); await sleep(1200);
  check('nothing preloaded before 50 percent', !requests.some(r => r.path.startsWith(`/audio/${b1}/15`)), requests.map(r => r.path).join(', ') || 'none');
  await seekTo(0.55); await sleep(1500);
  s = await state();
  const pre = requests.filter(r => r.path === `/audio/${b1}/15?voice=af_heart`);
  check('the next page is requested while the current one still plays', pre.length >= 1 && s.src === `/audio/${b1}/14?voice=af_heart`,
        pre.map(r => `${r.type} ${r.path}`).join(', ') || 'not requested');

  section('Speed and lock-screen buttons');
  await page.click('#speed-btn'); await sleep(300);
  s = await state();
  const pos2 = await lastPos();
  check('the speed button moves to 1.25x in the browser, pitch kept', s.rate === 1.25 && s.pitch === true && pos2.playbackRate === 1.25
        && (await page.$eval('#speed-btn', el => el.textContent.trim())) === '1.25x', `${s.rate} / ${pos2.playbackRate}`);
  check('a speed change needs no new audio', !requests.some(r => r.path.includes('speed')));
  await action('pause'); await sleep(300); s = await state();
  check('pause handler pauses, playbackState "paused"', s.paused && s.playbackState === 'paused', s.playbackState);
  await action('play'); await sleep(500); s = await state();
  check('play handler plays, playbackState "playing"', !s.paused && s.playbackState === 'playing', s.playbackState);
  await page.evaluate(() => { document.getElementById('audio-player').currentTime = 5; }); await sleep(200);
  await action('seekforward'); await sleep(200); s = await state();
  check('seekforward moves 15 s', s.time >= 19.5 && s.time < 22, s.time.toFixed(1));
  await action('seekbackward'); await sleep(200); s = await state();
  check('seekbackward moves back 15 s', s.time >= 4.5 && s.time < 7.5, s.time.toFixed(1));
  await action('seekto', { action: 'seekto', seekTime: 12 }); await sleep(200); s = await state();
  check('seekto jumps to 12 s', s.time >= 12 && s.time < 14, s.time.toFixed(1));

  section('Page end: the next page plays in the same element');
  const elBefore = await page.evaluateHandle(() => document.getElementById('audio-player'));
  saves.length = 0;
  await page.evaluate(() => { const a = document.getElementById('audio-player'); a.currentTime = a.duration - 0.4; });
  await waitPage(16); await waitPlaying(page); await sleep(400);
  s = await state();
  check('page 16 plays in the same, only, audio element', await page.evaluate(el => el === document.getElementById('audio-player')
        && document.querySelectorAll('audio').length === 1, elBefore) && !s.paused && s.src === `/audio/${b1}/15?voice=af_heart`, s.src);
  check('the speed carries over to the new page', s.rate === 1.25, s.rate);
  check('the lock-screen title follows the chapter', s.title === 'The Best Way to Start a New Habit', s.title);
  check('progress saved for page 16 with the speed', saves.some(v => v.page === 15 && v.speed === 1.25), JSON.stringify(saves.slice(-1)));

  section('Next and previous page from the lock screen');
  await action('nexttrack'); await waitPage(17); await sleep(300); s = await state();
  check('nexttrack: 16 -> 17', s.src === `/audio/${b1}/16?voice=af_heart`, s.src);
  await action('previoustrack'); await waitPage(16); await sleep(300); s = await state();
  check('previoustrack: 17 -> 16', s.src === `/audio/${b1}/15?voice=af_heart`, s.src);

  section('No preload when the next page has no audio yet');
  await page.evaluate(() => { document.getElementById('jump-input').value = '18'; window.jumpToPage(); });
  await waitPage(18); await waitPlaying(page); requests.length = 0;
  await seekTo(0.6); await sleep(1500);
  check('page 19 is not requested (so preloading never starts generation)', !requests.some(r => r.path.startsWith(`/audio/${b1}/18`)),
        requests.map(r => r.path).join(', ') || 'none');

  section('Sleep timer: end of page');
  await page.evaluate(() => { document.getElementById('jump-input').value = '10'; window.jumpToPage(); });
  await waitPage(10); await waitPlaying(page);
  await page.click('#sleep-btn'); await sleep(400);
  await page.click('.sleep-opt[data-sleep="page"]'); await sleep(300);
  await page.evaluate(() => { const a = document.getElementById('audio-player'); a.currentTime = a.duration - 0.4; });
  await sleep(2000);
  s = await state();
  check('playback stops at the end of the page instead of moving on', s.paused && s.page === '10' && s.playbackState === 'paused', `${s.page} paused=${s.paused}`);

  section('A book without a cover or contents');
  await page.click('#player-minimise'); await sleep(400);
  await page.click(`#library a[data-open-book="${b2}"]`);
  await page.waitForFunction(b2 => (document.getElementById('audio-player').getAttribute('src') || '').startsWith(`/audio/${b2}/`), { timeout: 15000 }, b2);
  await waitPlaying(page); await sleep(600);
  s = await state();
  check('title "Page 1 of 3", album and artist', s.title === 'Page 1 of 3' && s.album === 'Mere Christianity' && s.artist === 'C. S. Lewis',
        `${s.title} | ${s.album} | ${s.artist}`);
  const art = await page.evaluate(async () => { const a = navigator.mediaSession.metadata.artwork[2];
    const r = await fetch(a.src); const bmp = await createImageBitmap(await r.blob()); return `${r.status} ${bmp.width}x${bmp.height}`; });
  check('generated initials artwork loads at 512x512', art === '200 512x512', art);

  section('Voice names');
  const IDS = ['af_heart', 'af_nova', 'bf_emma', 'am_adam', 'am_echo', 'bm_george'];
  const picker = () => page.evaluate(() => ({
    options: [...document.querySelectorAll('#voice .voice-option')].map(o => ({ value: o.querySelector('input').value,
      name: o.querySelector('.voice-name').textContent, desc: o.querySelector('.voice-desc').textContent,
      checked: o.querySelector('input').checked })),
    text: document.getElementById('more-sheet').innerText }));
  await page.click('#more-btn'); await sleep(500);
  let v = await picker();
  check('the picker shows the six voices by name, in order', JSON.stringify(v.options.map(o => o.name))
        === '["Esinam","Enyonam","Enam","Elikem","Elorm","Eyram"]', v.options.map(o => o.name).join(', '));
  check('each with a short description', v.options[0].desc === 'warm, American, female' && v.options[2].desc === 'British, female'
        && v.options[5].desc === 'British, male' && v.options.every(o => o.desc.length > 0), v.options.map(o => o.desc).join(' | '));
  check('behind the names the ids are unchanged', JSON.stringify(v.options.map(o => o.value)) === JSON.stringify(IDS));
  check('no raw voice id is shown to the listener', !IDS.some(id => v.text.includes(id)));
  check('the default voice, af_heart, shows as Esinam', v.options.find(o => o.checked).name === 'Esinam'
        && v.options.find(o => o.checked).value === 'af_heart');
  await page.evaluate(() => Sheets.close()); await sleep(400);
  // A book saved earlier with an old id (bf_emma) opens with that voice, shown by its new name
  await page.evaluate(async id => {
    const token = document.querySelector('meta[name="csrf-token"]').content;
    await fetch('/save_progress', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRFToken': token },
      body: JSON.stringify({ book_id: Number(id), page: 0, speed: 1, voice: 'bf_emma' }) });
  }, b3);
  await page.evaluate(id => Player.open(id), b3);
  await page.waitForFunction(b3 => (document.getElementById('audio-player').getAttribute('src') || '').startsWith(`/audio/${b3}/`), { timeout: 15000 }, b3);
  await waitPlaying(page);
  s = await state();
  check('a book saved with an old id plays that voice (bf_emma)', s.src === `/audio/${b3}/0?voice=bf_emma`, s.src);
  await page.click('#more-btn'); await sleep(500);
  v = await picker();
  check('and the picker shows it as Enam', v.options.find(o => o.checked).value === 'bf_emma' && v.options.find(o => o.checked).name === 'Enam');
  saves.length = 0;
  await page.evaluate(() => [...document.querySelectorAll('#voice .voice-option')].find(o => o.querySelector('.voice-name').textContent === 'Elikem').click());
  await page.waitForFunction(() => (document.getElementById('audio-player').getAttribute('src') || '').includes('voice=am_adam'), { timeout: 15000 });
  await sleep(500);
  s = await state();
  check('choosing Elikem plays am_adam and saves the id, not the name', s.src === `/audio/${b3}/0?voice=am_adam`
        && saves.some(x => x.voice === 'am_adam') && !saves.some(x => /Elikem/.test(JSON.stringify(x))), `${s.src} ${JSON.stringify(saves.slice(-1))}`);
  await page.evaluate(() => Sheets.close()); await sleep(300);

  check('no JavaScript errors or failed requests', errors.length === 0, errors.slice(0, 5).join(' | '));
});
