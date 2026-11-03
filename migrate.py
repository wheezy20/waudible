"""Apply SQL migrations and import legacy JSON sessions into Postgres.

Uses the direct (unpooled) connection, as recommended for schema changes.
Usage: python migrate.py
"""
import glob
import json
import os

import psycopg
from dotenv import load_dotenv

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(ROOT_DIR, '.env.local'))
load_dotenv(os.path.join(ROOT_DIR, '.env'))

url = os.environ.get("DATABASE_URL_UNPOOLED") or os.environ["DATABASE_URL"]
SESSIONS_DIR = os.path.join(ROOT_DIR, 'data', 'sessions')

with psycopg.connect(url) as conn:
    conn.execute("""CREATE TABLE IF NOT EXISTS schema_migrations (
                        name TEXT PRIMARY KEY,
                        applied_at TIMESTAMPTZ NOT NULL DEFAULT now())""")
    applied = {r[0] for r in conn.execute("SELECT name FROM schema_migrations")}

    for path in sorted(glob.glob(os.path.join(ROOT_DIR, 'migrations', '*.sql'))):
        name = os.path.basename(path)
        if name in applied:
            continue
        with open(path) as f:
            conn.execute(f.read())
        conn.execute("INSERT INTO schema_migrations (name) VALUES (%s)", (name,))
        print(f"applied {name}")

    # One-time import of sessions saved by the old file-based storage
    imported = 0
    for path in glob.glob(os.path.join(SESSIONS_DIR, '*.json')):
        with open(path) as f:
            s = json.load(f)
        cur = conn.execute(
            """INSERT INTO book_sessions
                   (book_name, current_page, speed, voice, genre, cover)
               VALUES (%s, %s, %s, %s, %s, %s)
               ON CONFLICT (book_name) DO NOTHING""",
            (s["book_name"], s.get("current_page", 0), s.get("speed", 1.0),
             s.get("voice", "af_heart"), s.get("genre") or "Other",
             s.get("cover")),
        )
        imported += cur.rowcount
    print(f"imported {imported} legacy session(s)")
