import threading
import time
from collections import namedtuple
from flask_login import UserMixin

# ─────────────────────────────────────────
# SHORT-LIVED LOOKUPS FOR PAGE AUDIO
# Every /audio request used to make three database round trips before
# sending a byte: the connection check, the signed-in user and the owner
# check on the book, about 0.45 s together from this server to Neon (and
# a download asks for hundreds of pages). For /audio only, the user and
# "this book belongs to this user" are kept here for TTL seconds.
#
# Nothing is weakened: a request still needs a valid session (Flask-Login
# reads the user id from the signed cookie, and a logged-out request never
# gets here), and a book is only remembered after the database said it
# belongs to that user, under that user's id. Deleting a book or logging
# out forgets it at once. One gunicorn process, so one cache.
# ─────────────────────────────────────────
TTL = 60
MEDIA_ENDPOINTS = {"get_audio"}

_lock  = threading.Lock()
_users = {}     # user id -> (expires, CachedUser)
_books = {}     # (user id, book id) -> (expires, MediaBook)

MediaBook = namedtuple("MediaBook", "id user_id storage_key pages")


class CachedUser(UserMixin):
    """What /audio needs of the signed-in user: the id."""

    def __init__(self, user_id: int, display_name: str):
        self.id, self.display_name = user_id, display_name


def user(user_id: int, load):
    now = time.monotonic()
    with _lock:
        hit = _users.get(user_id)
        if hit and hit[0] > now:
            return hit[1]
    row = load()
    if row is None:
        return None
    cached = CachedUser(row.id, row.display_name)
    with _lock:
        _users[user_id] = (now + TTL, cached)
    return cached


def book(user_id: int, book_id: int):
    with _lock:
        hit = _books.get((user_id, book_id))
        return hit[1] if hit and hit[0] > time.monotonic() else None


def remember_book(user_id: int, row) -> MediaBook:
    """Only called with a row the owner check just returned."""
    entry = MediaBook(row.id, user_id, row.storage_key, row.pages)
    with _lock:
        _books[(user_id, row.id)] = (time.monotonic() + TTL, entry)
    return entry


def forget_book(book_id: int):
    with _lock:
        for key in [k for k in _books if k[1] == book_id]:
            del _books[key]


def forget_user(user_id: int):
    with _lock:
        _users.pop(user_id, None)
        for key in [k for k in _books if k[0] == user_id]:
            del _books[key]


def clear():
    with _lock:
        _users.clear()
        _books.clear()
