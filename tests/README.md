# WAudible tests

The suites write to the database (test users, books, progress), so they only ever run against a **temporary Neon branch**, never production. Every suite imports `tests/helpers.py`, which refuses to start when:

- `DATABASE_URL` or `DATABASE_URL_UNPOOLED` is not set in the environment (the app would otherwise read the production values from `.env`), or
- either one points at the same Neon endpoint as `.env` (production), or
- the two point at different databases.

It also:

- uses a throwaway `SECRET_KEY` and `INVITE_CODE`, never the real ones;
- keeps every file in a temporary folder (`WAUDIBLE_DATA_DIR`), never `data/`; and
- replaces Kokoro with a fake, so the suites are quick and need no model files.

Never edit `.env` to run the tests.

## What is covered

| Suite | File | What it checks |
|---|---|---|
| auth | `test_auth.py` | Sign-up with the invite code, login, logout, safe `next` redirects, CSRF |
| books | `test_books.py` | Uploads and their checks, processing, MP3 audio, progress, `/player`, the htmx page shell, build hash in asset URLs and cache headers, the voice routes, page audio with no database query once remembered (owner check, delete and logout respected, no connection held while a page is made), privacy between users, the queue, delete |
| worker | `test_worker.py` | Pages with nothing to say, failing pages, very long pages, the watchdog restarting the worker, voice pages ahead of the book queue, 48 kbps pages and `reencode_audio.py` |
| export | `test_export.py` | Save to device: filenames, chapters and sizes, ID3 tags, artwork and chapter markers (read back with ffprobe), length equal to the pages, incomplete selections refused, owner only, one build at a time, no leftover files, several chapters as one ZIP of stored MP3s |
| reqlog | `test_reqlog.py` | Slow request lines (route pattern only, nothing private), masked database connect errors, the 500 page during an outage |
| prod | `test_prod.py` | Debug off, cookies, security headers, rate limits by real client address, error pages, gunicorn settings, a real gunicorn on a spare port |
| nav | `browser/nav_check.js` | Audio keeps playing across navigation, mini player, switching and deleting books, upload, session end, logout |
| back | `browser/back_check.js` | Back closes the open sheet, then the player, before leaving the page |
| media | `browser/media_check.js` | Lock-screen details and buttons, speed, preloading the next page, page changes, sleep timer |
| offline | `browser/offline_check.js` | Manifest and service worker, downloading a book or chosen chapters (sizes and totals), adding and deleting chapters, playing offline (page change, seeking with Range requests, contents, lock screen, skipping pages that aren't downloaded), progress sync, the download suggestion, accounts kept apart, delete and logout cleanup |
| bgfetch | `browser/bgfetch_check.js` | Background Fetch downloads stored by the service worker (sizes, per-user cache, records), a failed size check fetched again alone, cancel from the notification, a refused fetch done by the app, Delete all; the app's own loop: three files at a time, Wake Lock, pause in the background and carry on, resume after the connection drops |
| save | `browser/save_check.js` | Save to device sheet from the book menu, the contents drawer and the Downloads screen, several chapters as one ZIP, real downloads checked with ffprobe, server errors, offline |
| update | `browser/update_check.js` | After a deploy: matching CSS, JS and service worker in one load, old cache dropped, the update bar, reloading by itself only when idle, a full load for links |
| voice | `browser/voice_check.js` | Changing voice: preparing status, old voice keeps playing, switching at the same place, the next 5 pages, lock screen, page end and downloads in the new voice, failures with Try again |

The browser suites run headless Chrome through `browser/server.py`, which seeds a test user and three books (the offline and bgfetch suites also get four more books and a second user; bgfetch also sends page audio slowly so a cancel or pause lands mid-download) and serves the app on a free local port. For the update suite it serves the static files from a copy and adds a test-only `/__test__/deploy` route that changes them and works out the build hash again; for the voice suite the fake Kokoro takes 3 s a page for Enam and Enyonam and always fails for Elorm. The voice suite saves screenshots of the picker, the preparing status and the error at 360x640 and 390x844, and the update suite one of the update bar. The offline suite saves screenshots at 360x640 and 390x844 of the download suggestion, the chapter confirm sheet, the Downloads screen (with and without a book's chapters) and the offline page into `SHOT_DIR` (default: the temporary data folder, which is deleted afterwards). The gunicorn checks in `prod` need the real Kokoro model files in the repo root and are skipped without them; your running service on port 8000 is not touched.

## One-time setup

```bash
npm install --prefix tests/browser      # puppeteer-core for the browser suites (gitignored)
```

The browser suites expect Chrome at `/usr/bin/google-chrome`; set `CHROME_PATH` to use another.

## 1. Create a temporary branch

A schema-only branch copies the tables but none of the data. Give it a short life:

```bash
neon branches create --project-id winter-unit-73193942 --name tests-$(date +%Y%m%d) \
    --parent production --schema-only --expires-at "$(date -u -d tomorrow +%Y-%m-%d)T23:59:59Z" --no-secrets
```

`--no-secrets` keeps the connection strings out of the terminal output.

## 2. Export its connection strings for the test run only

In the shell you will run the tests from (not in `.env`):

```bash
BRANCH=tests-$(date +%Y%m%d)
export DATABASE_URL="$(neon cs $BRANCH --project-id winter-unit-73193942 --pooled)"
export DATABASE_URL_UNPOOLED="$(neon cs $BRANCH --project-id winter-unit-73193942)"
```

These only exist in that shell. Close it (or `unset DATABASE_URL DATABASE_URL_UNPOOLED`) when you're done.

## 3. Run everything

```bash
./run_tests.sh                  # all suites, in order
./run_tests.sh auth books       # just some of them
```

Each suite prints PASS or FAIL per check, then a summary:

```
======== Summary (520s)
  auth     ok      34 passed, 0 failed (37s)
  books    ok      79 passed, 0 failed (100s)
  ...
ALL SUITES PASSED
```

`run_tests.sh` gives each suite a time limit (`TEST_TIMEOUT=<seconds>` overrides it). Whatever happens (a failure, a timeout or Ctrl+C), it stops any test gunicorn, deletes every test user (emails starting with `zz_test_`, with their books and progress) and removes the temporary folder. To clean up by hand:

```bash
venv/bin/python tests/cleanup.py
```

A single suite can also be run directly, for example `venv/bin/python tests/test_auth.py` or `venv/bin/python tests/browser/server.py nav_check.js`.

## 4. Delete the branch

It expires on its own, or:

```bash
neon branches delete $BRANCH --project-id winter-unit-73193942
```
