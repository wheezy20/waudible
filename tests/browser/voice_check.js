// Changing voice. Pages are made in the default voice; another voice is
// made on demand (server.py makes Enam and Enyonam take 3 s a page and
// Elorm always fail). The old voice keeps playing until the new page is
// ready, the next five pages are queued, failures are explained, and the
// chosen id is what gets sent, saved, and used on the lock screen and for
// downloads. Screenshots of the picker at 360x640 and 390x844.
const path = require('path');
const { env, books: { b1 }, sleep, check, section, login, waitPlaying, watchErrors, RECORDER, run } = require('./common');

run(async browser => {
  const page = await (await browser.createBrowserContext()).newPage();
  await page.setViewport({ width: 390, height: 844 });
  await page.evaluateOnNewDocument(RECORDER);
  const errors = watchErrors(page);
  const prepares = [], saves = [];
  page.on('request', r => {
    const u = new URL(r.url());
    if (u.pathname === '/voice/prepare') prepares.push(JSON.parse(r.postData()));
    if (u.pathname === '/save_progress') saves.push(JSON.parse(r.postData()));
  });
  const shot = name => page.screenshot({ path: path.join(env.SHOT_DIR, name) });
  const state = () => page.evaluate(() => {
    const a = document.getElementById('audio-player'), st = document.getElementById('voice-status');
    const src = a.getAttribute('src') ? new URL(a.src) : null;
    const checked = document.querySelector('#voice input:checked');
    return { src: src ? src.pathname + src.search : '', paused: a.paused, time: a.currentTime,
             page: document.getElementById('page-number').textContent.trim(),
             status: st.hidden ? '' : document.getElementById('voice-status-text').textContent,
             error: st.classList.contains('is-error'), retry: !document.getElementById('voice-retry').hidden,
             picked: checked && checked.value, note: document.getElementById('voice-note').hidden ? '' : document.getElementById('voice-note').textContent,
             voice: Player.voice(), pending: Player.pendingVoice() };
  });
  const pick = name => page.evaluate(n => [...document.querySelectorAll('#voice .voice-option')]
    .find(o => o.querySelector('.voice-name').textContent === n).click(), name);
  const srcHas = v => page.waitForFunction(v => (document.getElementById('audio-player').getAttribute('src') || '').includes(`voice=${v}`),
                                           { timeout: 45000 }, v);
  const serverVoice = () => page.evaluate(async id => (await (await fetch(`/player/${id}`)).json()).voice, b1);

  await login(page);
  await page.evaluate(id => Player.open(id), b1);
  await waitPlaying(page);
  await page.evaluate(() => { document.getElementById('audio-player').currentTime = 6; });

  section('Picking a voice that has to be made first');
  await page.click('#more-btn'); await sleep(500);
  await shot('voice-picker-390x844.png');
  prepares.length = 0; saves.length = 0;
  await pick('Enam');
  await sleep(600);
  let s = await state();
  check('"Preparing this page in Enam" shows near the seek bar', s.status === 'Preparing this page in Enam' && !s.error, s.status);
  check('the picker note says the old voice keeps playing', /Preparing this page in Enam\. Esinam keeps playing until it's ready/.test(s.note), s.note);
  check('the page carries on in the old voice meanwhile', s.src === `/audio/${b1}/14?voice=af_heart` && !s.paused && s.time > 6, `${s.src} ${s.time.toFixed(1)}`);
  check('the voice id (not the name) is sent for this page', prepares.length === 1 && prepares[0].voice === 'bf_emma'
        && prepares[0].page === 14 && prepares[0].book_id === Number(b1), JSON.stringify(prepares));
  check('nothing is saved as the new voice until it plays', !saves.some(x => x.voice === 'bf_emma'));
  await shot('voice-preparing-sheet-390x844.png');
  await page.evaluate(() => Sheets.close()); await sleep(400);
  await shot('voice-preparing-player-390x844.png');
  await page.setViewport({ width: 360, height: 640 }); await sleep(400);
  await shot('voice-preparing-player-360x640.png');
  await page.click('#more-btn'); await sleep(500);
  await shot('voice-picker-360x640.png');
  await page.evaluate(() => Sheets.close()); await sleep(300);
  await page.setViewport({ width: 390, height: 844 });

  await srcHas('bf_emma');
  const t0 = Date.now();
  await waitPlaying(page); await sleep(300);
  s = await state();
  check('when the page is ready it switches to Enam, still playing', s.src === `/audio/${b1}/14?voice=bf_emma` && !s.paused, s.src);
  check('from about the same place, not the start of the page', s.time > 6, s.time.toFixed(1));
  check('the status line goes away', s.status === '' && s.voice === 'bf_emma' && s.pending === null);
  await sleep(800);
  check('the chosen voice id is saved', saves.some(x => x.voice === 'bf_emma' && x.page === 14) && await serverVoice() === 'bf_emma',
        JSON.stringify(saves.slice(-1)));
  void t0;

  section('The next five pages, in the new voice');
  const readyIn = () => page.evaluate(async id => (await (await fetch(`/readiness/${id}?voice=bf_emma`)).json()).ready, b1);
  await page.waitForFunction(async id => {
    const r = (await (await fetch(`/readiness/${id}?voice=bf_emma`)).json()).ready;
    return [14, 15, 16, 17, 18, 19].every(p => r.includes(p));
  }, { timeout: 45000, polling: 1000 }, b1);
  const r = await readyIn();
  check('pages 15 to 20 are made in Enam, and nothing past them', [14, 15, 16, 17, 18, 19].every(p => r.includes(p)) && !r.includes(20)
        && !r.includes(13), r.join(','));

  section('Lock screen and page end use the new voice');
  await page.evaluate(() => window.__ms.actions.nexttrack({ action: 'nexttrack' }));
  await page.waitForFunction(() => document.getElementById('page-number').textContent.trim() === '16', { timeout: 15000 });
  await waitPlaying(page);
  s = await state();
  check('next track from the lock screen plays page 16 in Enam', s.src === `/audio/${b1}/15?voice=bf_emma`, s.src);
  await page.evaluate(() => { const a = document.getElementById('audio-player'); a.currentTime = a.duration - 0.4; });
  await page.waitForFunction(() => document.getElementById('page-number').textContent.trim() === '17', { timeout: 15000 });
  await waitPlaying(page);
  s = await state();
  check('the page ending moves on in Enam, same element', s.src === `/audio/${b1}/16?voice=bf_emma`
        && await page.evaluate(() => document.querySelectorAll('audio').length === 1), s.src);
  await sleep(500);
  check('pages after this one are asked for in Enam as listening goes on', prepares.some(p => p.voice === 'bf_emma' && p.page === 17),
        JSON.stringify(prepares.slice(-2)));

  section('Downloads use the saved voice');
  const man = await page.evaluate(async id => (await (await fetch(`/offline/manifest/${id}?texts=0`)).json()), b1);
  const audio = man.files.filter(f => f.url.startsWith('/audio/'));
  check('the download manifest is for Enam (bf_emma)', man.voice === 'bf_emma' && audio.length > 0
        && audio.every(f => f.url.endsWith('?voice=bf_emma')), `${man.voice} ${audio.slice(0, 2).map(f => f.url).join(' ')}`);

  section('A voice that fails');
  await page.click('#more-btn'); await sleep(400);
  await pick('Elorm');
  await page.waitForFunction(() => document.getElementById('voice-status').classList.contains('is-error'), { timeout: 20000 });
  s = await state();
  check('a clear error with the voice name', s.status === "Couldn't prepare this page in Elorm.", s.status);
  check('with a Try again button', s.retry);
  check('the picker goes back to the voice playing', s.picked === 'bf_emma' && s.voice === 'bf_emma', s.picked);
  check('Enam carries on playing', s.src.endsWith('?voice=bf_emma') && !s.paused, s.src);
  await page.evaluate(() => Sheets.close()); await sleep(400);
  await shot('voice-error-390x844.png');
  await page.setViewport({ width: 360, height: 640 }); await sleep(400);
  await shot('voice-error-360x640.png');
  await page.setViewport({ width: 390, height: 844 });
  prepares.length = 0;
  await page.click('#voice-retry');
  await sleep(300);
  s = await state();
  check('Try again asks for Elorm again', prepares.some(p => p.voice === 'am_echo') && s.status === 'Preparing this page in Elorm', s.status);
  await page.waitForFunction(() => document.getElementById('voice-status').classList.contains('is-error'), { timeout: 20000 });
  await page.click('#voice-dismiss'); await sleep(200);
  check('Dismiss hides the error', (await state()).status === '');
  check('the saved voice is still Enam', await serverVoice() === 'bf_emma');

  section('Changing page while a voice is being prepared');
  await page.click('#more-btn'); await sleep(400);
  prepares.length = 0;
  await pick('Enyonam');
  await sleep(300);
  await page.evaluate(() => Sheets.close()); await sleep(300);
  await page.click('#btn-next');
  await page.waitForFunction(() => document.getElementById('page-number').textContent.trim() === '18', { timeout: 15000 });
  await sleep(400);
  s = await state();
  check('the new page plays in the old voice meanwhile', s.src === `/audio/${b1}/17?voice=bf_emma` && s.pending === 'af_nova', s.src);
  check('and the new voice is asked for the new page', prepares.some(p => p.voice === 'af_nova' && p.page === 17),
        JSON.stringify(prepares));
  await srcHas('af_nova');
  s = await state();
  check('then it switches to Enyonam on that page', s.src === `/audio/${b1}/17?voice=af_nova` && s.status === '', s.src);

  section('Picking a voice that is already made switches at once');
  await page.click('#more-btn'); await sleep(400);
  await pick('Esinam');
  await srcHas('af_heart');
  s = await state();
  check('Esinam (the default, made with the book) plays straight away', s.src === `/audio/${b1}/17?voice=af_heart` && s.status === '', s.src);
  await sleep(600);
  check('and is saved', await serverVoice() === 'af_heart');
  await page.evaluate(() => Sheets.close()); await sleep(300);

  check('no JavaScript errors or failed requests', errors.length === 0, errors.slice(0, 5).join(' | '));
});
