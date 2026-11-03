# WAudible architecture

Target design for the multi-user hosted version. Today the app is single-user: books are identified by their uploaded filename, files sit in shared folders, and progress lives in one `book_sessions` table. This document describes where it is going.

## Overview

```
Browser (PWA)
   |
Cloudflare Tunnel  (waudio.eyramwilson.dev)
   |
Flask app (Flask-Login, Flask-SQLAlchemy)
   |-- Neon Postgres  (users, books, progress)
   |-- Local disk     (PDFs, covers, generated audio, all under storage_key)
   |-- Kokoro ONNX    (loaded once per process, background thread per book)
```

The app runs on the laptop first, reached through a Cloudflare Tunnel, and later on a VPS. Neon holds all structured data. Files stay on the server's disk.

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

When a user uploads a PDF, the app generates a random `storage_key` (for example `secrets.token_urlsafe(16)`) and stores every file for that book under it:

```
data/books/<storage_key>.pdf
data/covers/<storage_key>.<ext>
data/audio/<storage_key>/page<N>_spd<speed>_v<voice>.mp3
```

This keeps users' files apart:

- Two users can upload files with the same name without overwriting each other.
- The uploaded filename never becomes part of a path, which removes path traversal and odd-character problems.
- Keys can't be guessed, and the app still never trusts a key alone. Every request looks up the book by id **and** `user_id = current_user.id`, and returns 404 if they don't match. A user can't tell whether another user's book exists.
- Deleting a book means deleting one PDF, one cover and one audio folder, with no filename prefix matching.

## Routes

Only these routes are public:

| Route            | Purpose                 |
|------------------|-------------------------|
| `/signup`        | create an account       |
| `/login`         | sign in                 |
| `/static/...`    | CSS, JS, icons, PWA files |

Everything else needs `@login_required` and an ownership check on the book:

| Route                             | Purpose                                  |
|-----------------------------------|------------------------------------------|
| `/`                               | the user's library, grouped by genre     |
| `/logout`                         | sign out (POST)                          |
| `/upload`                         | upload a PDF and optional cover (POST)   |
| `/read/<book_id>`                 | reader page                              |
| `/audio/<book_id>/<page>`         | audio for one page                       |
| `/cover/<book_id>`                | cover image                              |
| `/status/<book_id>`               | background processing progress           |
| `/readiness/<book_id>`            | which pages have audio ready             |
| `/toc/<book_id>`                  | table of contents                        |
| `/page_text/<book_id>/<page>`     | page text preview                        |
| `/save_progress`                  | save current page, speed, voice (POST)   |
| `/delete/<book_id>`               | delete a book and all its files (POST)   |

Routes take the book's database id rather than the filename, which also fixes today's problems with spaces and special characters in URLs.

## Background audio processing

1. After an upload is saved, the app extracts every page's text with PyMuPDF and starts a daemon thread for that book.
2. The thread walks through the pages in order. For each page it calls Kokoro, writes the audio file, and updates `books.pages_done`. When the last page is done it sets `books.status` to `ready`. A small in-memory record keyed by `storage_key` tracks whether a thread is running, so a second one is never started for the same book.
3. Pages that already have audio are skipped, so restarting processing is cheap.
4. If the reader asks for a page that isn't ready yet, `/audio` generates that one page on demand.
5. The UI polls `/status` (which reads `status` and `pages_done` from the database) for the progress bar, and `/readiness` to see which pages can play.
6. Deleting a book sets `running` to false, which stops the thread at the next page, and then removes the files.

The Kokoro model is loaded once per process when the app starts.

Constraints that follow from this design:

- The "thread is running" record lives in process memory, so the app must run as a single process (one worker, threads allowed). With several workers, each would load its own Kokoro model and could start duplicate threads. If that is ever needed, move to a job queue.
- Processing progress (`pages_done`, `status`) survives a restart because it is in the database. A book left in `processing` after a restart needs its thread started again; since finished pages are skipped, it resumes where it stopped.
- Several users uploading at once means several threads competing for the same CPU. On a laptop or small VPS, a queue that processes one book at a time is the likely next step.
