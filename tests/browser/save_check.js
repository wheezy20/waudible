// Save to device: the sheet (chapters with sizes and a total, one file,
// pages), opened from the book menu, the contents drawer and the Downloads
// screen; real downloads checked with ffprobe (name, tags, artwork,
// length); errors from the server; offline. Screenshots at 360x640 and
// 390x844.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { base, env, books: { b1, b2 }, sleep, check, section, login, watchErrors, run } = require('./common');

const DL = path.join(env.OUT_DIR, 'save-downloads');
fs.mkdirSync(DL, { recursive: true });
const probe = file => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-show_chapters', '-of', 'json', file]));
const done = () => fs.readdirSync(DL).filter(f => !f.endsWith('.crdownload'));
async function waitFiles(n, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (done().length >= n && !fs.readdirSync(DL).some(f => f.endsWith('.crdownload'))) return done();
    await sleep(300);
  }
  return done();
}
const BOOK1 = 'Atomic Habits An Easy and Proven Way to Build Good Habits';

run(async browser => {
  const ctx = await browser.createBrowserContext({ downloadBehavior: { policy: 'allow', downloadPath: DL } });
  const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844 });
  const errors = watchErrors(page);
  const shot = name => page.screenshot({ path: path.join(env.SHOT_DIR, name) });
  const sheet = () => page.evaluate(() => ({
    open: Sheets.isOpen('save-sheet'),
    explain: document.querySelector('#save-sheet .save-explain').textContent,
    book: document.getElementById('save-book').textContent,
    message: document.getElementById('save-message').hidden ? '' : document.getElementById('save-message').textContent,
    rows: [...document.querySelectorAll('#save-chapters .dl-chapter')].map(r => ({ title: r.querySelector('.dl-chapter-title').textContent,
      meta: r.querySelector('.dl-chapter-meta').textContent, checked: r.querySelector('input').checked, disabled: r.querySelector('input').disabled })),
    total: document.getElementById('save-total').textContent, error: document.getElementById('save-error').textContent,
    button: document.getElementById('save-start').textContent, disabled: document.getElementById('save-start').disabled,
    voice: document.getElementById('save-voice-note').textContent,
    progress: document.getElementById('save-progress').hidden ? '' : document.getElementById('save-progress-text').textContent,
    progressError: document.getElementById('save-progress-error').textContent }));
  const fromMenu = async id => {
    await page.$eval(`.card-more[data-book-id="${id}"]`, b => b.scrollIntoView({ block: 'center', inline: 'center' })); await sleep(300);
    await page.click(`.card-more[data-book-id="${id}"]`); await sleep(400);
    await page.click('#book-save');
    await page.waitForFunction(() => !document.getElementById('save-form').hidden || !document.getElementById('save-message').hidden
                               && !/Loading/.test(document.getElementById('save-message').textContent), { timeout: 15000 });
    await sleep(300);
  };
  const mode = m => page.click(`.save-mode[data-mode="${m}"]`);

  await login(page);
  await page.goto(`${base}/library`);

  section('The sheet, from the book menu');
  await fromMenu(b1);
  let s = await sheet();
  check('it opens for the book with the one-line explanation', s.open && s.book.startsWith('Atomic Habits')
        && s.explain === "MP3 files go to your phone's Downloads folder, outside the app, for any music player, file manager or VLC.", s.explain);
  check('chapters with page ranges and sizes', s.rows.length === 5 && s.rows[1].title === 'The Fundamentals'
        && /^p\. 3 to 12, \d+(\.\d)? (KB|MB)$/.test(s.rows[1].meta), s.rows.map(r => r.meta).join(' | '));
  check('chapters not ready in the voice are shown but can\'t be picked', s.rows.map(r => r.disabled).join() === 'false,false,false,true,true'
        && s.rows[3].meta === 'p. 16 to 19, not ready in Esinam yet', s.rows[3].meta);
  check('the ready ones are picked, with a total', s.rows.filter(r => r.checked).length === 3 && /^3 chapters in one ZIP file, \d/.test(s.total)
        && s.button === 'Save ZIP' && !s.disabled, `${s.total} / ${s.button}`);
  check('it says which voice', s.voice === 'In Esinam, the voice you listen with.', s.voice);
  await shot('save-sheet-390x844.png');
  await page.setViewport({ width: 360, height: 640 }); await sleep(400);
  await shot('save-sheet-360x640.png');
  await page.setViewport({ width: 390, height: 844 }); await sleep(300);

  await mode('range');
  await page.$eval('#save-from', e => { e.value = ''; }); await page.type('#save-from', '17');
  await page.$eval('#save-to', e => { e.value = ''; }); await page.type('#save-to', '20');
  s = await sheet();
  check('pages that aren\'t all ready: explained, nothing to save', s.error === "Some of these pages aren't ready in Esinam yet." && s.disabled, s.error);
  await page.$eval('#save-to', e => { e.value = ''; }); await page.type('#save-to', '18');
  s = await sheet();
  check('pages 17 to 18 can be saved as one file', s.total.startsWith('1 file, ') && !s.disabled && s.error === '', s.total);
  await mode('whole');
  s = await sheet();
  check('the whole book as one file: refused while it isn\'t ready', s.error === "The whole book isn't ready in Esinam yet: 18 of 40 pages have audio."
        && s.disabled, s.error);

  section('Saving two chapters: one ZIP, one download');
  await mode('chapters');
  await page.click('#save-chapters .dl-chapter[data-chapter="0"] input'); await sleep(200);
  s = await sheet();
  const zipNote = await page.$eval('#save-zip-note', e => (e.hidden ? '' : e.textContent));
  check('the total says it is one ZIP', /^2 chapters in one ZIP file, \d/.test(s.total) && s.button === 'Save ZIP', `${s.total} / ${s.button}`);
  check('and explains why (it carries on in the background)', /carries on when you switch apps or lock the screen/.test(zipNote), zipNote);
  await shot('save-zip-390x844.png');
  await page.setViewport({ width: 360, height: 640 }); await sleep(300);
  await shot('save-zip-360x640.png');
  await page.setViewport({ width: 390, height: 844 }); await sleep(300);
  await page.click('#save-start');
  const files = await waitFiles(1);
  await page.waitForFunction(() => /on its way/.test(document.getElementById('save-progress-text').textContent), { timeout: 30000 });
  s = await sheet();
  check('it ends by saying where it went', s.progress === 'The ZIP with 2 chapters is on its way to your Downloads folder. It carries on if you switch apps.', s.progress);
  await shot('save-progress-390x844.png');
  const zipName = `${BOOK1} - Chapters 2 to 3.zip`;
  check('one ZIP lands in Downloads', JSON.stringify(files) === JSON.stringify([zipName]), files.join(' | '));
  const want = [`${BOOK1} - 02 The Fundamentals.mp3`, `${BOOK1} - 03 The Man Who Didn't Look Right.mp3`];
  if (files.includes(zipName)) {
    // List and unpack it with Python's zipfile (no extra tools needed)
    const listing = JSON.parse(execFileSync('python3', ['-c', `import json,sys,zipfile
z = zipfile.ZipFile(sys.argv[1]); z.extractall(sys.argv[2])
print(json.dumps([[i.filename, i.compress_type] for i in z.infolist()]))`, path.join(DL, zipName), path.join(DL, 'unzipped')]).toString());
    check('with the two chapter MP3s, stored uncompressed', JSON.stringify(listing.map(x => x[0])) === JSON.stringify(want)
          && listing.every(x => x[1] === 0), JSON.stringify(listing));
    const p = probe(path.join(DL, 'unzipped', want[0]));
    const tags = p.format.tags || {};
    check('tags: chapter, book, author, track, genre', tags.title === 'The Fundamentals' && tags.album.startsWith('Atomic Habits')
          && tags.artist === 'James Clear' && tags.track === '2/5' && tags.genre === 'Audiobook', JSON.stringify(tags));
    check('the cover is embedded', p.streams.some(x => x.codec_type === 'video' && x.disposition.attached_pic === 1));
    const pageLen = await page.evaluate(async id => {
      const buf = await (await fetch(`/audio/${id}/2?voice=af_heart`)).arrayBuffer();
      return new Promise(r => new AudioContext().decodeAudioData(buf, b => r(b.duration), () => r(0)));
    }, b1);
    const dur = Number(p.format.duration);
    check('ten pages long (the sum of its pages), with a marker per page', p.chapters.length === 10 && Math.abs(dur - 10 * pageLen) < 1,
          `${dur.toFixed(2)} s vs 10 x ${pageLen.toFixed(2)} s`);
  }
  await page.evaluate(() => Sheets.close()); await sleep(400);

  section('One file for the whole book');
  fs.rmSync(DL, { recursive: true, force: true }); fs.mkdirSync(DL, { recursive: true });
  await fromMenu(b2);
  await mode('whole');
  s = await sheet();
  check('a finished book can be saved as one file', s.total.startsWith('1 file, ') && !s.disabled, s.total);
  await page.click('#save-start');
  const one = await waitFiles(1);
  check('it lands as "Mere Christianity.mp3"', JSON.stringify(one) === '["Mere Christianity.mp3"]', one.join(' | '));
  if (one.length) {
    const p = probe(path.join(DL, one[0]));
    check('three pages long, tagged with the book', Math.abs(Number(p.format.duration) - 3 * 30) < 1.5
          && p.format.tags.album === 'Mere Christianity' && p.format.tags.artist === 'C. S. Lewis', p.format.duration);
  }
  await page.evaluate(() => Sheets.close()); await sleep(400);

  section('A chapter from the contents drawer');
  await page.evaluate(id => Player.open(id, { autoplay: false }), b1);
  await page.waitForFunction(() => document.querySelectorAll('.toc-row .toc-save').length === 5, { timeout: 15000 });
  await page.evaluate(() => openToc()); await sleep(600);
  await shot('save-drawer-390x844.png');
  const label = await page.$eval('.toc-row:nth-child(3) .toc-save', b => b.getAttribute('aria-label'));
  check('each chapter has a Save to device button', label === "Save The Man Who Didn't Look Right to device", label);
  await page.click('.toc-row:nth-child(3) .toc-save');
  await page.waitForFunction(() => !document.getElementById('save-form').hidden, { timeout: 15000 }); await sleep(300);
  s = await sheet();
  check('the sheet opens with only that chapter picked', s.open && s.rows.filter(r => r.checked).map(r => r.title).join() === "The Man Who Didn't Look Right"
        && s.total.startsWith('1 file, '), s.rows.filter(r => r.checked).map(r => r.title).join());
  await page.setViewport({ width: 360, height: 640 }); await sleep(400);
  await shot('save-from-drawer-360x640.png');
  await page.setViewport({ width: 390, height: 844 }); await sleep(300);

  section('An error from the server is shown');
  await page.setRequestInterception(true);
  const intercept = r => {
    if (new URL(r.url()).pathname === `/export/${b1}/check`) {
      r.respond({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: '"The Man" isn\'t ready to save yet: 2 of 3 pages have audio in this voice.' }) });
    } else r.continue();
  };
  page.on('request', intercept);
  fs.rmSync(DL, { recursive: true, force: true }); fs.mkdirSync(DL, { recursive: true });
  await page.click('#save-start');
  await page.waitForFunction(() => document.getElementById('save-progress-error').textContent, { timeout: 15000 });
  s = await sheet();
  check('the server\'s message shows, and nothing is downloaded', s.progress === "This couldn't be saved:"
        && s.progressError.includes("isn't ready to save yet") && done().length === 0, `${s.progress} ${s.progressError}`);
  await shot('save-error-390x844.png');
  page.off('request', intercept);
  await page.setRequestInterception(false);
  await page.evaluate(() => Sheets.close()); await sleep(300);
  await page.evaluate(() => closeToc()); await sleep(300);
  // The deliberate 409 isn't an error of the app
  for (let i = errors.length - 1; i >= 0; i--) if (errors[i].includes(`/export/${b1}/check`)) errors.splice(i, 1);

  section('Offline');
  await page.evaluate(() => Player.collapse()); await sleep(400);
  await page.setOfflineMode(true);
  await page.waitForFunction(() => !Offline.isOnline(), { timeout: 10000 });
  await fromMenu(b1);
  s = await sheet();
  check('it says saving needs a connection', s.message === "Saving to your device needs a connection. Try again when you're online.", s.message);
  await page.evaluate(() => Sheets.close()); await sleep(300);
  await page.setOfflineMode(false);
  await page.waitForFunction(() => Offline.isOnline(), { timeout: 10000 });

  section('A chapter from the Downloads screen');
  await page.evaluate(id => Offline.download(Number(id), { quiet: true }), b2);
  await page.waitForFunction(id => Offline.state(Number(id)).name === 'downloaded', { timeout: 30000 }, b2);
  await page.goto(`${base}/downloads`);
  await page.waitForSelector('.dl-toggle', { timeout: 15000 });
  await page.click('.dl-toggle'); await sleep(400);
  const dlSave = await page.$$eval('.dl-ch-save', bs => bs.map(b => b.getAttribute('aria-label')));
  check('downloaded chapters have a Save to device button', dlSave.length === 1 && dlSave[0] === 'Save Pages 1 to 3 to device', dlSave.join(' | '));
  await page.click('.dl-ch-save');
  await page.waitForFunction(() => !document.getElementById('save-form').hidden, { timeout: 15000 }); await sleep(300);
  s = await sheet();
  check('which opens the sheet for that chapter', s.open && s.book === 'Mere Christianity' && s.rows.length === 1 && s.rows[0].checked);
  await page.evaluate(() => Sheets.close()); await sleep(300);

  check('no JavaScript errors or failed requests', errors.length === 0, errors.slice(0, 5).join(' | '));
});
