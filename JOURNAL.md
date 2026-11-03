# WAudible journal

Newest entry first.

## 3 Nov 2026

Where things stand at the start of the online version:

- Shrank audio storage (step 4). Pages are now MP3 (mono, 64 kbps, made with ffmpeg) instead of WAV, about 17% of the size: a 3-page test book went from 1647 KB of WAV to 276 KB of MP3. Audio is generated once per voice at speed 1.0, and the reader changes speed in the browser, so a speed change no longer generates new audio. Added `convert_wav_to_mp3.py` to convert the existing WAV files; on a copy of book 68's first 9 pages it turned 76.1 MB into 12.7 MB.
- Tests now run against a temporary schema-only Neon branch instead of production. The test process gets the branch's connection strings in its own environment, and `.env` keeps pointing at production. Branch `tests-mp3-20261103` expires on 4 Nov 2026 at 23:59 UTC.

- Made books private per user (step 3). Books and reading progress now live in the `books` and `progress` tables, and every file is stored under a random `storage_key` (`data/books/<key>.pdf`, `data/covers/<key>.<ext>`, `data/audio/<key>/`). Routes use book ids, every route except login and register needs login, and another user's book returns 404. Uploads are limited to 100 MB, must really be PDFs, covers must be real JPG, PNG or WebP under 5 MB, and each user can have 20 books.
- Replaced the thread per book with one worker thread and a queue, so books are processed one at a time in upload order. Progress is saved to the database after every page, and unfinished books are re-queued on startup.
- The running app no longer uses `book_sessions`, `app/db.py` or `app/session_manager.py`. They stay in place until Eyram confirms after testing. The two old local books are still on disk but not in anyone's library yet.

- The local single-user app is built (Flask, Kokoro ONNX, PyMuPDF, genre shelves, cover art, background audio processing, auto-resume) and pushed to GitHub as `wheezy20/waudible`.
- Started the `online-version` branch for the multi-user hosted version. `main` stays as the original local app.
- Hosting search:
  - Oracle Cloud signup failed.
  - Google Cloud was too expensive, at about $33 a month.
  - Hetzner's cheap plans are gone after the 2026 price rises.
  - Decision: serve the app from the laptop through a Cloudflare Tunnel first, and move to a VPS later.
- Created the Neon Postgres project in London (`eu-west-2`) and linked it with the Neon CLI (`neon init`, `neon deploy`). The connection variables live in `.env`.
- Moved reading progress from JSON files in `data/sessions/` to a Postgres `book_sessions` table and imported the two existing sessions. Committed as `7e5c31a`.
- Wrote the project docs: CLAUDE.md, PLAN.md, JOURNAL.md and ARCHITECTURE.md.
- Added accounts: sign-up (invite code required), login and logout in an `auth` blueprint, with Flask-WTF CSRF protection on every form, including the existing upload, delete and save progress requests. Book routes are not protected yet. The app now needs `SECRET_KEY` and `INVITE_CODE` in `.env` (see `.env.example`).
- Added Flask-SQLAlchemy and Flask-Login. Created the `User`, `Book` and `Progress` models in `app/models.py`, and ran `init_db.py` to create the `users`, `books` and `progress` tables in Neon. The old `book_sessions` storage keeps running until auth works.
