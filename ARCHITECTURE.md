# WAudible architecture

Design of the multi-user hosted version. Accounts, per-user books, `storage_key` file storage and the processing queue are built. MP3 audio, hosting and the PWA are still to come (see PLAN.md).

## Overview

```
Browser (PWA)
   |
Cloudflare Tunnel  (waudio.eyramwilson.dev)
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
- Every response gets `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin` and a Content-Security-Policy: same-origin for everything except Google Fonts (`fonts.googleapis.com` for the stylesheet, `fonts.gstatic.com` for font files), `frame-ancestors 'none'`, `object-src 'none'`. Scripts and styles allow `'unsafe-inline'` because the pages use inline `<script>` blocks, `onclick=` handlers and `style=` attributes. Moving the JavaScript into static files would let the CSP drop `'unsafe-inline'` for scripts.

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
| `/static/...`    | CSS, JS, icons, PWA files |

Everything else needs login. A single `before_request` check in `app/main.py` sends logged-out requests to `/login?next=...`, so new routes are private by default. Book routes also check ownership:

| Route                             | Purpose                                  |
|-----------------------------------|------------------------------------------|
| `/`                               | the user's library, grouped by genre     |
| `/logout`                         | sign out (POST)                          |
| `/upload`                         | upload a PDF and optional cover (POST)   |
| `/read/<book_id>`                 | reader page                              |
| `/audio/<book_id>/<page>?voice=`  | MP3 for one page                         |
| `/cover/<book_id>`                | cover image                              |
| `/status/<book_id>`               | background processing progress           |
| `/readiness/<book_id>?voice=`     | which pages have audio ready for a voice |
| `/toc/<book_id>`                  | table of contents                        |
| `/page_text/<book_id>/<page>`     | page text preview                        |
| `/save_progress`                  | save page, speed, voice (POST, JSON with `book_id`) |
| `/delete/<book_id>`               | delete a book and all its files (POST)   |

Routes take the book's database id rather than the filename, which also avoids problems with spaces and special characters in URLs.

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
7. The UI polls `/status` (`total`, `done`, `running`, read from the database) for the progress bar, and `/readiness` to see which pages can play.
8. Deleting a book marks its `storage_key` as cancelled and removes its audio folder, then deletes the rows and the other files. The worker checks before every page and stops. Writing a page and deleting a book share a lock, so a page that finishes during a delete is dropped instead of recreating the folder.

The Kokoro model is loaded once per process when the app starts.

Constraints that follow from this design:

- The queue lives in process memory, so the app must run as a single process (one worker process, threads allowed). With several processes, each would load its own Kokoro model and run its own queue. If that is ever needed, move to a shared job queue.
- The queue itself is lost on restart, but nothing else is: progress is in the database, and step 5 rebuilds the queue from it.
