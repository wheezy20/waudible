# WAudible

WAudible is a Flask app that turns PDF books into audiobooks using Kokoro ONNX text-to-speech. It started as a single-user app on localhost and is being turned into a multi-user hosted app. See PLAN.md for the roadmap, ARCHITECTURE.md for the target design, and JOURNAL.md for the history so far.

## Branches

- `online-version`: all work on the hosted, multi-user version happens here.
- `main`: the original local app. Never commit to, merge into, or rebase `main`.

## Stack

- **Flask** for the web server and Jinja templates (HTMX and plain JS on the frontend)
- **Flask-SQLAlchemy** for models and queries (psycopg 3 driver, URL scheme `postgresql+psycopg://`)
- **Flask-Login** for sessions and `@login_required`
- **Neon Postgres**, project `winter-unit-73193942`, branch `production`, region London (`eu-west-2`)
- **Kokoro ONNX** for text-to-speech (`kokoro-v1.0.onnx` and `voices-v1.0.bin` in the repo root, gitignored)
- **PyMuPDF** (`fitz`) for PDF text and table of contents extraction

## Layout

- `app/main.py`: Flask config and routes (login required everywhere except login and register, books looked up by id and owner)
- `app/tts_engine.py`: loads Kokoro once, generates page audio (MP3, speed 1.0, one file per voice), allowed voices and speeds
- `app/audio_codec.py`: ffmpeg MP3 encoding and the startup ffmpeg check
- `convert_wav_to_mp3.py`: one-off conversion of old WAV pages, to be deleted once it has been run
- `app/worker.py`: the single background worker and its queue
- `app/storage.py`: paths for files stored under each book's `storage_key`
- `app/pdf_reader.py`: page text, page count, metadata, table of contents
- `app/session_manager.py`, `app/db.py`: old single-user storage, no longer used by the app, kept until deletion is confirmed
- `app/config.py`: `database_url(unpooled=False)` builds the SQLAlchemy URL from the Neon env vars
- `app/auth.py`: `auth` blueprint (`/register`, `/login`, `/logout`), Flask-Login setup, forms
- `app/models.py`: Flask-SQLAlchemy models (`User`, `Book`, `Progress`) and the shared `db` object
- `init_db.py`: creates the `users`, `books` and `progress` tables (`python init_db.py`, safe to rerun)
- `app/templates/`, `app/static/css/style.css`: UI
- `migrate.py`, `migrations/`: old table creation for `book_sessions`, no longer used, kept until deletion is confirmed
- `data/books`, `data/covers`, `data/audio`: uploaded files and generated audio (gitignored)

## Running the app

One-time setup:

```bash
sudo apt install espeak-ng ffmpeg -y
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
# Kokoro model files go in the repo root (see README.md for the download links)
```

Run it:

```bash
./run.sh            # activates venv, runs python run.py on http://localhost:5000
```

Startup takes a few seconds because the Kokoro model loads at import time.

## Neon setup

- `neon deploy` (or `neon env pull`) writes the connection variables into `.env`.
- `DATABASE_URL` is the **pooled** connection (hostname contains `-pooler`). The running app uses this.
- `DATABASE_URL_UNPOOLED` is the **direct** connection. Use it for creating tables and other schema changes, never the pooled one.
- Neon's pooler is PgBouncer in transaction mode, so server-side prepared statements must stay off for app connections.
- `SECRET_KEY` (Flask session signing) and `INVITE_CODE` (required to sign up) also live in `.env`. The app refuses to start without `SECRET_KEY`. `.env.example` lists every key with placeholder values.
- `neon.ts` holds the branch policy. New non-default branches expire after 7 days.

## Working rules

- Never print, echo, log or commit anything from `.env` (connection strings, passwords, secret keys). When a value must be checked, mask it.
- No em dashes or en dashes anywhere: prose, docs, code comments, commit messages or UI text. Use commas or parentheses instead.
- No `Co-Authored-By` or `Claude-Session` trailers in commit messages.
- Keep `PLAN.md` checkboxes current and add a dated entry at the top of `JOURNAL.md` when something significant happens.
