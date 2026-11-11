# WAudible architecture

Design of the multi-user hosted version. Accounts, per-user books, `storage_key` file storage, the processing queue, MP3 audio, hosting and the offline PWA are built (see PLAN.md).

## Overview

```
Browser (PWA)
   |
Cloudflare Tunnel  (waudible.eyramwilson.dev)
   |
Flask app (Flask-Login, Flask-SQLAlchemy)
   |-- Neon Postgres  (users, books, progress)
   |-- Local disk     (PDFs, covers, generated audio, all under storage_key)
   |-- Kokoro ONNX    (loaded once, one worker thread and a queue)
```

The app runs on the laptop first, reached through a Cloudflare Tunnel, and later on a VPS. Neon holds all structured data. Files stay on the server's disk.

## Production server

```
Internet -> Cloudflare -> cloudflared (tunnel) -> gunicorn 127.0.0.1:8000 -> Flask app
```

- `run_prod.sh` starts gunicorn with `gunicorn.conf.py`: exactly **one worker process** (the Kokoro model and the audio queue must exist once), 4 threads, a 120 second timeout (audio can be generated on demand), bound to `127.0.0.1:8000` only. It is never exposed on `0.0.0.0`; only cloudflared on the same machine connects to it.
- gunicorn's `post_worker_init` hook starts the audio queue worker in the worker process, which re-queues unfinished books straight away (before any request).
- systemd runs `run_prod.sh` as `wheezy20` and restarts it on failure (`deploy/waudible.service`, install steps in `deploy/README.md`).
- `run.sh` and `run.py` are only for local development on `http://localhost:5000`.

### Settings from the environment

| Variable                  | Default | Meaning                                                    |
|---------------------------|---------|------------------------------------------------------------|
| `WAUDIBLE_DEBUG`          | off     | `1` turns on the Flask debugger. Never in production.       |
| `WAUDIBLE_SECURE_COOKIES` | on      | `0` allows cookies over plain http (`run.sh` sets this).    |

### Behind the tunnel

- `ProxyFix` trusts one proxy hop (`X-Forwarded-For`, `-Proto`, `-Host`), so the app sees the real client address and `https`. Only the last `X-Forwarded-For` value is used, so a value the client adds itself is ignored. This is safe only because gunicorn listens on 127.0.0.1.
- Over https, Flask-WTF also checks that the `Referer` of a form post or `fetch` is this site. Browsers send it, because the Referrer-Policy keeps the full referrer for same-origin requests.

### Cookies and headers

- Session cookie: `Secure` (https only), `HttpOnly`, `SameSite=Lax`.
- Every response gets `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin` and a Content-Security-Policy: same-origin for everything except Google Fonts (`fonts.googleapis.com` for the stylesheet, `fonts.gstatic.com` for font files), `worker-src 'self'`, `manifest-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`. `/sw.js` gets its own policy: same-origin, plus `connect-src` for the two Google Fonts hosts so the worker can keep the font for offline use. Scripts and styles allow `'unsafe-inline'` because the pages use inline `<script>` blocks, `onclick=` handlers and `style=` attributes. Moving the JavaScript into static files would let the CSP drop `'unsafe-inline'` for scripts.

### Rate limits

Flask-Limiter, in-memory storage (fine with one process), keyed by the real client IP:

- `POST /login` and `POST /register`: 10 per minute. Requests that fail the CSRF check get a 400 and don't count, because they never reach the password check.
- `POST /upload`: 20 per hour. Over the limit, the library shows a message.

Limits reset when the app restarts.

### Error pages

`app/templates/error.html` shows friendly pages for 400, 404, 413, 429 and 500, never a stack trace (debug is off; the real error goes to the log). Uploads that are too large or over the rate limit go back to the library with a message instead. Error pages don't touch the database, so they render even if Neon is unreachable.

## Database

All tables are created through Flask-SQLAlchemy over the direct connection (`DATABASE_URL_UNPOOLED`). The running app uses the pooled connection (`DATABASE_URL`).

### users

| Column        | Type        | Notes                         |
|---------------|-------------|-------------------------------|
| id            | integer PK  |                               |
| email         | text        | unique, stored lowercase      |
| password_hash | text        | Werkzeug password hash        |
| display_name  | text        |                               |
| created_at    | timestamptz | default now()                 |

### books

| Column        | Type        | Notes                                          |
|---------------|-------------|------------------------------------------------|
| id            | integer PK  |                                                |
| user_id       | FK users.id | owner, `ON DELETE CASCADE`, indexed            |
| storage_key   | text        | unique, random, names the book's files         |
| original_name | text        | uploaded filename, for display only, never a path |
| title         | text        | from PDF metadata, falls back to the filename  |
| author        | text        |                                                |
| pages         | integer     | page count                                     |
| genre         | text        | default `Other`                                |
| cover         | text        | cover filename, null when there is no cover    |
| status        | text        | `processing` or `ready` (check constraint)     |
| pages_done    | integer     | pages with audio generated so far              |
| created_at    | timestamptz | default now()                                  |

### progress

| Column       | Type         | Notes                               |
|--------------|--------------|-------------------------------------|
| id           | integer PK   |                                     |
| book_id      | FK books.id  | unique, `ON DELETE CASCADE`         |
| current_page | integer      | 0-based, default 0                  |
| speed        | float        | default 1.0                         |
| voice        | text         | default `af_heart`                  |
| updated_at   | timestamptz  | updated on every save               |

One progress row per book. Every book has exactly one owner, so the owner is reached through `books.user_id`. Deleting a user removes their books, and deleting a book removes its progress (cascades in both the database and the SQLAlchemy relationships).

Models live in `app/models.py`. `init_db.py` creates the tables.

## File storage and storage_key

When a user uploads a PDF, the app generates a random `storage_key` (`secrets.token_hex(16)`) and stores every file for that book under it. Path helpers live in `app/storage.py`.

```
data/books/<storage_key>.pdf
data/covers/<storage_key>.<ext>          (jpg, png or webp)
data/audio/<storage_key>/page<N>_v<voice>.mp3
```

The voice is part of audio paths, so the app only accepts the known voices.

## Audio format and speed

- Pages are MP3, mono, 64 kbps, which is plenty for speech and about 17% of the size of the old WAV files. Code: `app/audio_codec.py`.
- Kokoro's samples are piped into ffmpeg (`subprocess` with an argument list, never a shell string), and the MP3 is written to a temp file and renamed, so a half-written page is never served.
- The app checks at startup that ffmpeg with the MP3 encoder is installed, and stops with a clear message if not.
- Audio is generated once per voice, always at speed 1.0. The reader page changes speed in the browser with `audioEl.playbackRate` (with `preservesPitch`), so changing speed never fetches or generates new audio. The chosen speed is kept between pages and saved in `progress.speed`, which only accepts the five speeds the reader offers (0.75, 1.0, 1.25, 1.5, 2.0).
- `/audio` is served as `audio/mpeg`. `/audio` and `/readiness` take only `?voice=`.

This keeps users' files apart:

- Two users can upload files with the same name without overwriting each other.
- The uploaded filename never becomes part of a path, which removes path traversal and odd-character problems.
- Keys can't be guessed, and the app still never trusts a key alone. Every request looks up the book by id **and** `user_id = current_user.id`, and returns 404 if they don't match. A user can't tell whether another user's book exists.
- Deleting a book means deleting one PDF, one cover and one audio folder, with no filename prefix matching.

## Routes

Only these routes are public:

| Route            | Purpose                 |
|------------------|-------------------------|
| `/register`      | create an account (invite code) |
| `/login`         | sign in                 |
| `/static/...`    | CSS, JS, icons          |
| `/manifest.webmanifest` | web app manifest |
| `/sw.js`         | service worker (no-cache, version filled in by the app) |
| `/offline`       | the offline page shell (no user data, no CSRF token) |

Everything else needs login. A single `before_request` check in `app/main.py` sends logged-out requests to `/login?next=...`, so new routes are private by default. Book routes also check ownership:

| Route                             | Purpose                                  |
|-----------------------------------|------------------------------------------|
| `/`                               | Home: continue listening and the shelves |
| `/library`                        | Library: the shelves on their own        |
| `/logout`                         | sign out (POST)                          |
| `/upload`                         | upload a PDF and optional cover (POST)   |
| `/read/<book_id>`                 | Home with this book opened in the player |
| `/player/<book_id>`               | JSON the player needs to load a book     |
| `/audio/<book_id>/<page>?voice=`  | MP3 for one page                         |
| `/cover/<book_id>`                | cover image                              |
| `/status/<book_id>`               | background processing progress           |
| `/readiness/<book_id>?voice=`     | which pages have audio ready for a voice |
| `/toc/<book_id>`                  | table of contents                        |
| `/page_text/<book_id>/<page>`     | page text preview                        |
| `/save_progress`                  | save page, speed, voice (POST, JSON with `book_id`) |
| `/delete/<book_id>`               | delete a book and all its files (POST)   |
| `/downloads`                      | Downloads screen (drawn from the device) |
| `/offline/manifest/<book_id>`     | everything to download one finished book (409 while processing) |
| `/offline/size/<book_id>`         | quick size estimate for the confirm step and the suggestion |
| `/offline/books`                  | the user's book ids (to drop downloads of deleted books) |
| `/offline/csrf`                   | a fresh CSRF token for syncing progress saved offline |

Routes take the book's database id rather than the filename, which also avoids problems with spaces and special characters in URLs.

## Page shell and the persistent player

Audio keeps playing while you move around the app, like Spotify.

- `base.html` is the page shell: header, `#app-content`, the one `<audio>` element, the mini player, the full player sheet (`_player.html`), the bottom bar and the bottom sheets. `fragment.html` is the content-only layout.
- In-app links and forms use htmx (self-hosted `static/js/htmx.min.js`, version 2.0.11) with `hx-boost`, and only `#app-content` is swapped. `render_page()` in `app/main.py` returns the full page for normal loads and history restores, and just the content when the `HX-Request` header is present, so every URL also works as a plain page load.
- htmx settings (meta `htmx-config`): `allowEval` off (CSP has no `unsafe-eval`), `historyCacheSize` 0 (no page snapshots with user data in `localStorage`; the back button asks the server).
- `static/js/player.js` sets up the player exactly once: audio events, controls, sleep timer, readiness dots, preloading and the Media Session. `Player.open(id)` loads a book from `/player/<id>` (saving the previous book's progress first); opening the book that is already loaded just expands the sheet.
- `static/js/app.js` runs page scripts after every swap (filter chips, processing rings, upload errors, `/read/<id>`) and cleans up their listeners and timers before the next one.
- A login redirect during an htmx request becomes `HX-Redirect`, so the browser loads the login page in full. Logout is a normal form post (not htmx), so the shell and its audio are thrown away.
- Deleting the book in the player (or one that is still opening) stops and clears the player and its lock-screen details.
- The Back button closes the top layer first (a bottom sheet, then the full player) instead of leaving the page. `Layers` in `static/js/sheets.js` pushes a history entry at the same address when a layer opens and steps back over it when the layer is closed another way, so history and the screen stay in step. Its `popstate` listener runs before htmx's and stops it when the Back only closed a layer.
- CSRF tokens don't expire on a timer (`WTF_CSRF_TIME_LIMIT = None`), because the shell's token stays in use for the whole session; they are still tied to the session.

## Offline listening (PWA)

Code: `app/sw.js` (service worker, served at `/sw.js`), `static/js/offline.js` (downloads, storage, sync, the Downloads screen and the offline page), small hooks in `player.js` and `app.js`.

### Installing

`/manifest.webmanifest`: name WAudible, `display: standalone`, `start_url /`, background `#121212`, theme `#E95420`, icons at 192 and 512 (`static/icons/`, made from `assets/waudible.png`) and a maskable 512. `/sw.js` is served with `Cache-Control: no-cache`, and the app writes a version into it (a hash of the worker, the shell files and the templates), so any change installs a new worker, which takes over straight away and deletes the old shell cache.

### What the service worker does

| Request | Strategy |
|---|---|
| Page navigations | Network first. With no network, the precached `/offline` page. Pages are never cached. |
| App shell (`/offline`, the manifest, CSS, scripts, icons) | Cache first, from `waudible-shell-<version>` (precached on install) |
| Google Fonts stylesheet and font files | Cache first, from `waudible-fonts-v1` |
| `/audio/...` and `/cover/...` | Cache first from the signed-in user's own `waudible-media-u<user id>`, else the network. Range requests get `206` with `Content-Range` (or `416`), so seeking and lock-screen scrubbing work offline. |
| Everything else (JSON, form posts, `/offline/*` routes) | Network only, never cached |

The worker only reads the media caches; `offline.js` is the only thing that writes to them. It knows who is signed in from a `{type: 'user'}` message that each page sends and from IndexedDB. The login and register pages (`static/js/signed-out.js`) tell it that nobody is, so it serves no one's downloads until the next account's first page.

### Downloading a book

1. The card menu and the player's More sheet have "Download for offline", enabled only when the book's status is `ready` and the device is online. The confirm step shows `/offline/size` (exact audio sizes plus a guess for covers and text) and says only the current voice is downloaded.
2. `navigator.storage.persist()` is requested, and `navigator.storage.estimate()` must show room for the book (plus a margin), or a clear message is shown instead.
3. `/offline/manifest/<id>` gives the title, author, genre, page count, contents, cover URL, every page's text, and for the user's current voice the URL and byte size of every page's audio, the cover and the three lock-screen artwork sizes.
4. Files are fetched one at a time into `waudible-media-u<user id>`, under the same URLs the player uses, and each one's size must match the manifest. A progress ring shows on the cover and in the sheet, and the download can be cancelled (which removes what was saved). If it stops part way (connection lost, app closed), the next online visit carries on, skipping files already saved.
5. IndexedDB `waudible` holds, keyed by `[user id, book id]`: `books` (details, contents, page text, file list, size, voice, complete or not) and `progress` (page, speed, voice, time, synced or not); `meta` holds the signed-in user for the offline page.

### Playing

`Player.open` uses a complete downloaded copy when there is one, online too (it saves data). With no network the details, contents and page text come from IndexedDB, and the audio and artwork from the cache through the worker, so the mini player, Media Session, speed, sleep timer and contents drawer work as usual. Offline, the voice picker is disabled with a note, Add and Delete explain that they need a connection, books that aren't downloaded are dimmed, and opening one shows a short message instead of an error. An Offline badge shows in the header.

### Progress

Every save goes to IndexedDB first, then to `/save_progress`. A save that can't be sent stays marked unsynced. When the connection is back (and on every online page load), `offline.js` gets a fresh token from `/offline/csrf` and sends each unsynced position with its time (`at`, ms). The server ignores a position older than the one it has (`{"status": "stale"}`) and otherwise saves it with that time (never later than now). A failed send keeps the position for the next try. When a downloaded book opens online, a newer unsynced position on the device wins over the server's.

### The suggestion

When a ready book that isn't downloaded is opened online, a sheet offers to download it: "Download for offline listening? About X MB. Streaming uses data and stops when your connection drops." Download, Not now (asks again after a week), or Don't ask again for this book, remembered in `localStorage` per user and book. It isn't shown while the book is processing, when there isn't room, when the book is already on the device, or more than once per visit.

### Cleanup and accounts

- On every online page load the device compares its downloads with `/offline/books` and deletes copies of books that no longer exist. Deleting a book in the app deletes its copy straight away.
- Logging out first says how many downloaded books (and how much space) will be deleted, then deletes that user's downloads, progress, cached name and suggestion choices, and only then posts the logout.
- Everything is keyed by user id, so another account on the same browser never sees or gets served someone else's downloads.

## Upload rules

- The whole upload request is limited to 100 MB (`MAX_CONTENT_LENGTH`).
- The file must start with `%PDF` and open in PyMuPDF. The extension alone is not trusted.
- Covers must be JPG, PNG or WebP, checked by their first bytes, and at most 5 MB.
- Each user can have at most 20 books.
- Rejected uploads leave no files and no rows, and show a message on the home page.

## Background audio processing

Code: `app/worker.py` (queue and worker), `app/tts_engine.py` (Kokoro and audio files).

1. After an upload is saved, the book row is created with `status = 'processing'` and its id is put on a queue. The upload request returns straight away.
2. One worker thread takes book ids off the queue, one at a time, in upload order. Many uploads at once just make the queue longer instead of competing for the CPU.
3. For each page the worker calls Kokoro (default voice, speed 1.0), encodes MP3, writes the file, and saves `books.pages_done` to the database. After the last page it sets `books.status` to `ready`.
4. Pages that already have audio are skipped, so a book that is processed again resumes where it stopped.
5. When the app starts (the first request, or `run.py` in the debug reloader's serving process), the worker starts and every book still marked `processing` is put back on the queue.
6. If the reader asks for a page that isn't ready yet, `/audio` generates that one page on demand.
7. A page with nothing to say (no letters or digits, or Kokoro returns no audio) becomes about 5 seconds of silence, long enough that Android keeps its media notification. Pages longer than 1500 characters are spoken in chunks split at sentence ends and joined with a short pause.
8. If a page fails for any other reason, the worker logs it with the book id and page, retries once, then writes the same silent placeholder and carries on, so one bad page never stops a book. When a book finishes, the log says how many pages failed.
9. A watchdog thread checks every 30 seconds that the worker thread is alive. If it ever stopped, the watchdog starts a new one and re-queues every book still marked `processing`.
10. The UI polls `/status` (`total`, `done`, `running`, read from the database) for the progress bar, and `/readiness` to see which pages can play.
11. Deleting a book marks its `storage_key` as cancelled and removes its audio folder, then deletes the rows and the other files. The worker checks before every page and stops. Writing a page and deleting a book share a lock, so a page that finishes during a delete is dropped instead of recreating the folder.

The Kokoro model is loaded once per process when the app starts.

Constraints that follow from this design:

- The queue lives in process memory, so the app must run as a single process (one worker process, threads allowed). With several processes, each would load its own Kokoro model and run its own queue. If that is ever needed, move to a shared job queue.
- The queue itself is lost on restart, but nothing else is: progress is in the database, and step 5 rebuilds the queue from it.
- Worker messages go to stderr through the `app` logger, so under systemd they are in `journalctl -u waudible`.

## Logging

Everything the app logs goes to stderr through the `app` logger, so under systemd it is in `journalctl -u waudible`.

- **Slow requests** (`app/request_log.py`): a request that takes more than 3 seconds (`SLOW_REQUEST_SECONDS`) logs one WARNING line, for example `Slow request: GET /audio/<int:book_id>/<int:page> 200 in 4.01 s`. It shows the route pattern, never the real path or query string, and never bodies, cookies, users or emails. The timer starts before the login check; streaming a file's body after the response starts is not counted.
- **Database connect errors**: a SQLAlchemy `handle_error` listener logs one ERROR line when a connection can't be made (failed pre-pings that the pool recovers from are skipped). Quoted values, IP addresses and the host, user, password and database name are masked.
- **Server errors**: Flask still logs the exception and traceback (`Exception on <path>`), and gunicorn's access log still records every request with its full path. The 500 page falls back to plain HTML if the normal page can't render (for example while the database is down).
