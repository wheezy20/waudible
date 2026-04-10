import json
import os

SESSIONS_DIR = os.path.join(os.path.dirname(__file__), '..', 'data', 'sessions')
os.makedirs(SESSIONS_DIR, exist_ok=True)


def _session_path(book_name: str) -> str:
    safe_name = book_name.replace(" ", "_").replace("/", "_")
    return os.path.join(SESSIONS_DIR, f"{safe_name}.json")


def save_progress(book_name: str, page: int, speed: float = 1.0,
                  voice: str = "af_heart", genre: str = "Other",
                  cover: str = None):
    """Save reading progress and book metadata."""
    # Load existing session to preserve fields we're not updating
    existing = load_progress(book_name)
    session = {
        "book_name"   : book_name,
        "current_page": page,
        "speed"       : speed,
        "voice"       : voice,
        "genre"       : genre or existing.get("genre", "Other"),
        "cover"       : cover or existing.get("cover", None),
    }
    with open(_session_path(book_name), 'w') as f:
        json.dump(session, f, indent=2)


def save_metadata(book_name: str, genre: str, cover: str = None):
    """Save only genre and cover without touching reading progress."""
    existing = load_progress(book_name)
    existing["genre"] = genre
    if cover:
        existing["cover"] = cover
    with open(_session_path(book_name), 'w') as f:
        json.dump(existing, f, indent=2)


def load_progress(book_name: str) -> dict:
    """Load session. Returns defaults if none exists."""
    path = _session_path(book_name)
    if os.path.exists(path):
        with open(path, 'r') as f:
            return json.load(f)
    return {
        "book_name"   : book_name,
        "current_page": 0,
        "speed"       : 1.0,
        "voice"       : "af_heart",
        "genre"       : "Other",
        "cover"       : None,
    }


def get_all_sessions() -> list[dict]:
    sessions = []
    for filename in os.listdir(SESSIONS_DIR):
        if filename.endswith('.json'):
            with open(os.path.join(SESSIONS_DIR, filename), 'r') as f:
                sessions.append(json.load(f))
    return sessions


def delete_session(book_name: str):
    path = _session_path(book_name)
    if os.path.exists(path):
        os.remove(path)