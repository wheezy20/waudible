from app.db import get_pool

COLUMNS = "book_name, current_page, speed, voice, genre, cover"


def _defaults(book_name: str) -> dict:
    return {
        "book_name"   : book_name,
        "current_page": 0,
        "speed"       : 1.0,
        "voice"       : "af_heart",
        "genre"       : "Other",
        "cover"       : None,
    }


def save_progress(book_name: str, page: int, speed: float = 1.0,
                  voice: str = "af_heart", genre: str = None,
                  cover: str = None):
    """Save reading progress and book metadata."""
    # Preserve existing genre/cover when not explicitly provided
    with get_pool().connection() as conn:
        conn.execute(
            f"""INSERT INTO book_sessions ({COLUMNS})
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (book_name) DO UPDATE SET
                    current_page = EXCLUDED.current_page,
                    speed        = EXCLUDED.speed,
                    voice        = EXCLUDED.voice,
                    genre        = COALESCE(%s, book_sessions.genre),
                    cover        = COALESCE(EXCLUDED.cover, book_sessions.cover),
                    updated_at   = now()""",
            (book_name, page, speed, voice, genre or "Other", cover, genre),
        )


def save_metadata(book_name: str, genre: str, cover: str = None):
    """Save only genre and cover without touching reading progress."""
    with get_pool().connection() as conn:
        conn.execute(
            """INSERT INTO book_sessions (book_name, genre, cover)
               VALUES (%s, %s, %s)
               ON CONFLICT (book_name) DO UPDATE SET
                   genre      = EXCLUDED.genre,
                   cover      = COALESCE(EXCLUDED.cover, book_sessions.cover),
                   updated_at = now()""",
            (book_name, genre, cover),
        )


def load_progress(book_name: str) -> dict:
    """Load session. Returns defaults if none exists."""
    with get_pool().connection() as conn:
        row = conn.execute(
            f"SELECT {COLUMNS} FROM book_sessions WHERE book_name = %s",
            (book_name,),
        ).fetchone()
    return row or _defaults(book_name)


def get_all_sessions() -> list[dict]:
    with get_pool().connection() as conn:
        return conn.execute(f"SELECT {COLUMNS} FROM book_sessions").fetchall()


def delete_session(book_name: str):
    with get_pool().connection() as conn:
        conn.execute("DELETE FROM book_sessions WHERE book_name = %s",
                     (book_name,))
