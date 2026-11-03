# WAudible journal

Newest entry first.

## 3 Nov 2026

Where things stand at the start of the online version:

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
- Added Flask-SQLAlchemy and Flask-Login. Created the `User`, `Book` and `Progress` models in `app/models.py`, and ran `init_db.py` to create the `users`, `books` and `progress` tables in Neon. The old `book_sessions` storage keeps running until auth works.
