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
   |-- Kokoro ONNX    (loaded once per process, one worker thread and a queue)
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

When a user uploads a PDF, the app generates a random `storage_key` (`secrets.token_hex(16)`) and stores every file for that book under it. Path helpers live in `app/storage.py`.

```
data/books/<storage_key>.pdf
data/covers/<storage_key>.<ext>          (jpg, png or webp)
data/audio/<storage_key>/page<N>_spd<speed>_v<voice>.wav   (.mp3 after step 4)
```

Speed and voice are part of audio paths, so the app only accepts the known voices and the five speeds the reader offers (0.75, 1.0, 1.25, 1.5, 2.0).

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
| `/audio/<book_id>/<page>`         | audio for one page                       |
| `/cover/<book_id>`                | cover image                              |
| `/status/<book_id>`               | background processing progress           |
| `/readiness/<book_id>`            | which pages have audio ready             |
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
3. For each page the worker calls Kokoro, writes the audio file, and saves `books.pages_done` to the database. After the last page it sets `books.status` to `ready`.
4. Pages that already have audio are skipped, so a book that is processed again resumes where it stopped.
5. When the app starts (the first request, or `run.py` in the debug reloader's serving process), the worker starts and every book still marked `processing` is put back on the queue.
6. If the reader asks for a page that isn't ready yet, `/audio` generates that one page on demand.
7. The UI polls `/status` (`total`, `done`, `running`, read from the database) for the progress bar, and `/readiness` to see which pages can play.
8. Deleting a book marks its `storage_key` as cancelled and removes its audio folder, then deletes the rows and the other files. The worker checks before every page and stops. Writing a page and deleting a book share a lock, so a page that finishes during a delete is dropped instead of recreating the folder.

The Kokoro model is loaded once per process when the app starts.

Constraints that follow from this design:

- The queue lives in process memory, so the app must run as a single process (one worker process, threads allowed). With several processes, each would load its own Kokoro model and run its own queue. If that is ever needed, move to a shared job queue.
- The queue itself is lost on restart, but nothing else is: progress is in the database, and step 5 rebuilds the queue from it.
