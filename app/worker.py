import logging
import queue
import threading
import time
from app.models import db, Book
from app.pdf_reader import extract_pages
from app.storage import pdf_path
from app.tts_engine import text_to_audio, silent_page, is_cancelled

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
# ─────────────────────────────────────────
_queue       = queue.Queue()
_thread      = None
_watchdog    = None
_start_lock  = threading.Lock()
WATCHDOG_SECONDS = 30


def enqueue(book_id: int):
    _queue.put(book_id)


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
        book_id = _queue.get()
        try:
            _process_book(app, book_id)
        except Exception:
            log.exception("Audio processing failed for book %s", book_id)
        finally:
            _queue.task_done()


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
