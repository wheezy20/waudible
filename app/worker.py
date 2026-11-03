import logging
import queue
import threading
from app.models import db, Book
from app.pdf_reader import extract_pages
from app.storage import pdf_path
from app.tts_engine import text_to_audio, is_cancelled

log = logging.getLogger(__name__)

# ─────────────────────────────────────────
# ONE WORKER, ONE QUEUE
# Books are processed one at a time, in upload
# order, so many uploads can't overload the server.
# Progress lives in the database (books.pages_done
# and books.status), so it survives a restart.
# ─────────────────────────────────────────
_queue       = queue.Queue()
_thread      = None
_start_lock  = threading.Lock()


def enqueue(book_id: int):
    _queue.put(book_id)


def start_worker(app):
    """
    Start the worker thread once per process, and re-queue
    any books left in "processing" by a previous run.
    """
    global _thread
    with _start_lock:
        if _thread is not None and _thread.is_alive():
            return
        _thread = threading.Thread(target=_run, args=(app,),
                                   name="audio-worker", daemon=True)
        _thread.start()

    with app.app_context():
        unfinished = (db.session.query(Book.id)
                      .filter_by(status="processing")
                      .order_by(Book.created_at, Book.id)
                      .all())
    for (book_id,) in unfinished:
        enqueue(book_id)
    if unfinished:
        print(f"Re-queued {len(unfinished)} unfinished book(s)")


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
        for i, text in enumerate(pages):
            if is_cancelled(storage_key):
                return
            if text_to_audio(text, storage_key, page=i) is None:
                return
            if not _set_progress(book_id, {"pages_done": i + 1}):
                return

        _set_progress(book_id, {"pages_done": len(pages), "status": "ready"})
