// Shared bits for the headless Chrome checks. server.py starts the app and
// passes everything through the environment.
const path = require('path');
const puppeteer = require(path.join(__dirname, 'node_modules', 'puppeteer-core'));

const env = process.env;
const base = env.BASE_URL;
const books = { b1: env.BOOK1, b2: env.BOOK2, b3: env.BOOK3 };
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failed = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== '' && detail !== undefined ? `  [${detail}]` : ''}`);
  if (!ok) failed++;
  return !!ok;
}
const section = title => console.log(`== ${title} ==`);

function launch() {
  return puppeteer.launch({
    executablePath: env.CHROME_PATH || '/usr/bin/google-chrome', headless: true,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
}

// Records what the page registers with the Media Session (browsers can't list handlers)
const RECORDER = () => {
  window.__ms = { actions: {}, positions: [] };
  const ms = navigator.mediaSession;
  const setAction = ms.setActionHandler.bind(ms);
  ms.setActionHandler = (action, handler) => { window.__ms.actions[action] = handler; return setAction(action, handler); };
  const setPos = ms.setPositionState.bind(ms);
  ms.setPositionState = state => { window.__ms.positions.push(state); return setPos(state); };
};

async function login(page) {
  await page.goto(`${base}/login`);
  await page.type('#email', env.EMAIL);
  await page.type('#password', env.PASSWORD);
  await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);
}

const waitPlaying = page => page.waitForFunction(() => {
  const a = document.getElementById('audio-player');
  return a.readyState >= 2 && !a.paused && a.currentTime > 0.2;
}, { timeout: 30000 });

const waitView = (page, v) => page.waitForFunction(v => {
  const p = document.querySelector('#app-content .page'); return p && p.dataset.view === v;
}, { timeout: 45000 }, v);

// Errors worth failing on (the app has no favicon, so its 404 is expected)
function watchErrors(page) {
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => {
    if ((m.type() === 'error' || m.type() === 'warn') && !m.text().startsWith('Failed to load resource')) errors.push(m.text());
  });
  page.on('response', r => { if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) errors.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  return errors;
}

async function run(main) {
  const browser = await launch();
  try {
    await main(browser);
  } catch (e) {
    check('test run finished', false, String(e && e.stack || e).split('\n').filter((l, i) => i === 0 || l.includes('_check.js')).join(' / ').slice(0, 400));
  } finally {
    await browser.close();
  }
  process.exit(failed ? 1 : 0);
}

module.exports = { base, books, env, sleep, check, section, launch, login, waitPlaying, waitView, watchErrors, RECORDER, run };
