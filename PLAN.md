# WAudible roadmap

Turning WAudible from a single-user local app into a multi-user hosted app. Work in this order and tick each item when it is done.

## Groundwork

- [x] Local single-user app built and pushed to GitHub
- [x] Neon project created (London, `eu-west-2`) and connected; reading progress moved from JSON files to Postgres

## 1. Database models and table creation

- [x] Flask-SQLAlchemy models for `users`, `books` and `progress` in `app/models.py` (see ARCHITECTURE.md)
- [x] `init_db.py` creates the tables over `DATABASE_URL_UNPOOLED`
- [x] App connects with the pooled `DATABASE_URL` through Flask-SQLAlchemy

Old single-user storage. The running app no longer uses any of it (since step 3). Delete once Eyram confirms after testing:

- [ ] Drop the `book_sessions` table
- [ ] Delete `app/db.py` (psycopg pool)
- [ ] Delete `migrate.py` and `migrations/`
- [ ] Delete `app/session_manager.py`
- [x] Replace the filename-based `app/main.py` routes (done in step 3)

## 2. Sign-up, login and logout

- [x] Flask-Login setup with password hashing
- [x] Sign-up (invite code required), login and logout pages in `app/auth.py`
- [x] Spotify-style dark UI in Ubuntu orange (`#E95420`)
- [x] CSRF protection on every form (Flask-WTF)
- [x] Put real `SECRET_KEY` and `INVITE_CODE` values in `.env`

## 3. Per-user libraries

- [x] Every book belongs to a user, stored in the `books` and `progress` tables
- [x] Files stored under a random `storage_key` instead of the uploaded filename
- [x] Every route except login, register and static files requires login
- [x] Every book route looks up the book by id and owner, and returns 404 if it isn't yours
- [x] Upload limits: 100 MB request, real PDF check, JPG/PNG/WebP covers up to 5 MB, 20 books per user
- [x] One background worker and a queue, progress saved in the database, resumes after a restart
- [ ] Move the existing local books (`data/books/AAA.pdf`, `data/books/Atomic habits.pdf`) into the first user account

## 4. Convert generated audio from WAV to MP3

- [x] Generate MP3 (mono, 64 kbps) with ffmpeg instead of WAV
- [x] Serve MP3 as `audio/mpeg`
- [x] Generate once per voice at speed 1.0; the browser changes speed with `playbackRate`
- [x] Check for ffmpeg at startup
- [x] Eyram runs `convert_wav_to_mp3.py` on the existing WAV files
- [x] Delete `convert_wav_to_mp3.py` from the repo after it has been run

## 5. Go live at waudio.eyramwilson.dev

- [x] Production server: gunicorn, 1 worker process, 4 threads, 120 s timeout, on 127.0.0.1:8000 only (`run_prod.sh`, `gunicorn.conf.py`)
- [x] Audio queue worker starts under gunicorn and re-queues unfinished books
- [x] ProxyFix for Cloudflare's headers; debug off unless `WAUDIBLE_DEBUG=1`
- [x] Secure, HttpOnly, SameSite=Lax cookies (`WAUDIBLE_SECURE_COOKIES=0` for local http)
- [x] Security headers (nosniff, frame DENY, Referrer-Policy, CSP)
- [x] Rate limits: login and sign-up 10 per minute per IP, uploads 20 per hour per IP
- [x] Friendly 400, 404, 413, 429 and 500 pages
- [x] systemd unit and install steps in `deploy/`
- [ ] Install the systemd service (`deploy/README.md`)
- [ ] Cloudflare Tunnel from the laptop to `http://127.0.0.1:8000`
- [ ] DNS for `waudio.eyramwilson.dev`
- [ ] Move to a VPS later

## 6. PWA offline mode

- [ ] Web app manifest and service worker
- [ ] Download button on each book to save the full audiobook for offline listening
- [ ] Pop-up recommending downloading the full audiobook instead of streaming
