import collections
import logging
import threading
import time
from app.models import db, Book
from app.pdf_reader import extract_page, extract_pages
from app.storage import pdf_path
from app.tts_engine import text_to_audio, silent_page, is_cancelled, get_audio_path

log = logging.getLogger(__name__)

# ─────────────────────────────────────────
# ONE WORKER, ONE QUEUE
# Books are processed one at a time, in upload
# order, so many uploads can't overload the server.
# Progress lives in the database (books.pages_done
# and books.status), so it survives a restart.
# A watchdog restarts the worker thread if it ever
# stops, and a page that fails is retried once, then
# replaced by silence so the book still finishes.
#
# Books are made in the default voice. Another voice is made when a
# listener picks it: the page they are on and the next VOICE_AHEAD pages
# go in a second queue, which comes first. The worker takes voice pages
# before the next book and between the pages of the book it is making,
# so a listener waits for at most one book page plus their own.
# ─────────────────────────────────────────
_cond        = threading.Condition()
_books       = collections.deque()    # book ids, in upload order
_voice_jobs  = collections.deque()    # VoiceJob, first in line first
_voice_state = {}                     # (book_id, voice, page) -> {"state", "at"}
_thread      = None
_watchdog    = None
_start_lock  = threading.Lock()
WATCHDOG_SECONDS = 30
VOICE_AHEAD  = 5                      # pages after the current one
FAILED_KEEP_SECONDS = 3600            # how long a failure is reported

VoiceJob = collections.namedtuple("VoiceJob", "user_id book_id storage_key page voice")


def enqueue(book_id: int):
    with _cond:
        _books.append(book_id)
        _cond.notify()


def enqueue_voice(user_id: int, book_id: int, storage_key: str, voice: str, pages) -> None:
    """
    Make these pages in this voice next, in this order, ahead of the book
    queue. Replaces whatever this user still had waiting (they moved on
    to another page, voice or book); a page being made carries on.
    """
    now = time.time()
    with _cond:
        for job in [j for j in _voice_jobs if j.user_id == user_id]:
            _voice_jobs.remove(job)
            _voice_state.pop((job.book_id, job.voice, job.page), None)
        for key in [k for k, v in _voice_state.items()
                    if v["state"] == "failed" and now - v["at"] > FAILED_KEEP_SECONDS]:
            del _voice_state[key]
        new = []
        for page in pages:
            key = (book_id, voice, page)
            if _voice_state.get(key, {}).get("state") == "working":
                continue
            if get_audio_path(storage_key, page, voice):
                _voice_state.pop(key, None)
                continue
            _voice_state[key] = {"state": "queued", "at": now}
            new.append(VoiceJob(user_id, book_id, storage_key, page, voice))
        _voice_jobs.extendleft(reversed(new))
        if new:
            _cond.notify()


def voice_state(book_id: int, storage_key: str, voice: str, page: int) -> str:
    """ready, queued, working, failed or none (not asked for)."""
    if get_audio_path(storage_key, page, voice):
        return "ready"
    with _cond:
        return _voice_state.get((book_id, voice, page), {}).get("state", "none")


def _take():
    """The next job: a voice page if any is waiting, else a book."""
    with _cond:
        while not _voice_jobs and not _books:
            _cond.wait()
        if _voice_jobs:
            return "voice", _voice_jobs.popleft()
        return "book", _books.popleft()


def _next_voice_job():
    with _cond:
        return _voice_jobs.popleft() if _voice_jobs else None


def _set_voice_state(job, state):
    with _cond:
        key = (job.book_id, job.voice, job.page)
        if state is None:
            _voice_state.pop(key, None)
        else:
            _voice_state[key] = {"state": state, "at": time.time()}


def _voice_page(job):
    """One page in a voice a listener picked. Tried once: the listener is
    waiting, and sees the error with a Try again button instead."""
    if is_cancelled(job.storage_key):
        _set_voice_state(job, None)
        return
    _set_voice_state(job, "working")
    try:
        text = extract_page(pdf_path(job.storage_key), job.page)
        text_to_audio(text, job.storage_key, page=job.page, voice=job.voice, book_id=job.book_id)
        _set_voice_state(job, None)          # ready: the file is there
    except Exception:
        if is_cancelled(job.storage_key):
            _set_voice_state(job, None)
            return
        log.exception("Book %s page %s: audio in voice %s failed", job.book_id, job.page + 1, job.voice)
        _set_voice_state(job, "failed")
        # The pages after it would most likely fail the same way, a minute
        # each: drop them (Try again asks for them afresh)
        with _cond:
            for other in [j for j in _voice_jobs if (j.user_id, j.book_id, j.voice) == (job.user_id, job.book_id, job.voice)]:
                _voice_jobs.remove(other)
                _voice_state.pop((other.book_id, other.voice, other.page), None)


def _run_voice_jobs():
    while (job := _next_voice_job()) is not None:
        _voice_page(job)


def start_worker(app):
    """
    Start the worker thread (and its watchdog) once per process, and
    re-queue any books left in "processing" by a previous run.
    """
    global _watchdog
    if not _ensure_thread(app):
        return
    with _start_lock:
        if _watchdog is None:
            _watchdog = threading.Thread(target=_watch, args=(app,),
                                         name="audio-watchdog", daemon=True)
            _watchdog.start()
    _requeue_unfinished(app)


def worker_alive() -> bool:
    return _thread is not None and _thread.is_alive()


def _ensure_thread(app) -> bool:
    """Start the worker thread if it isn't running. True if it was started."""
    global _thread
    with _start_lock:
        if worker_alive():
            return False
        _thread = threading.Thread(target=_run, args=(app,),
                                   name="audio-worker", daemon=True)
        _thread.start()
        return True


def _requeue_unfinished(app):
    with app.app_context():
        unfinished = (db.session.query(Book.id)
                      .filter_by(status="processing")
                      .order_by(Book.created_at, Book.id)
                      .all())
    for (book_id,) in unfinished:
        enqueue(book_id)
    if unfinished:
        log.info("Re-queued %s unfinished book(s)", len(unfinished))


def _watch(app):
    while True:
        time.sleep(WATCHDOG_SECONDS)
        try:
            if _ensure_thread(app):
                log.error("Audio worker thread had stopped, started a new one")
                _requeue_unfinished(app)
        except Exception:
            log.exception("Audio worker watchdog failed, trying again later")


def _run(app):
    while True:
        kind, job = _take()
        try:
            if kind == "voice":
                _voice_page(job)
            else:
                _process_book(app, job)
        except Exception:
            log.exception("Audio processing failed for %s %s", kind, job)


def _set_progress(book_id: int, values: dict) -> bool:
    """Update the book row. False means the book was deleted."""
    updated = Book.query.filter_by(id=book_id).update(values)
    db.session.commit()
    return updated > 0


def _process_book(app, book_id: int):
    with app.app_context():
        book = db.session.get(Book, book_id)
        # Deleted, or a duplicate queue entry for a finished book
        if book is None or book.status != "processing":
            return
        storage_key = book.storage_key
        db.session.commit()   # don't hold a connection while Kokoro runs

        try:
            pages = extract_pages(pdf_path(storage_key))
        except Exception:
            if is_cancelled(storage_key):
                return
            raise

        # Pages that already have audio are skipped by text_to_audio,
        # so a re-queued book resumes where it stopped
        failed = 0
        for i, text in enumerate(pages):
            _run_voice_jobs()               # listeners waiting for a voice go first
            if is_cancelled(storage_key):
                return
            path, ok = _page_audio(book_id, storage_key, i, text)
            failed += not ok
            if path is None:
                return
            if not _set_progress(book_id, {"pages_done": i + 1}):
                return

        _set_progress(book_id, {"pages_done": len(pages), "status": "ready"})
        if failed:
            log.warning("Book %s finished: %s pages, %s failed and replaced by silence",
                        book_id, len(pages), failed)
        else:
            log.info("Book %s finished: %s pages", book_id, len(pages))


def _page_audio(book_id: int, storage_key: str, page: int, text: str):
    """
    Audio for one page: try, retry once, then the silent placeholder.
    Returns (path or None if the book was deleted, False if the page failed).
    """
    for attempt in (1, 2):
        try:
            return text_to_audio(text, storage_key, page=page, book_id=book_id), True
        except Exception:
            log.exception("Book %s page %s: audio failed (attempt %s of 2)",
                          book_id, page + 1, attempt)
    return silent_page(storage_key, page), False
