"""The audio worker: pages with nothing to say, pages that fail, very long
pages, and a worker thread that dies and is restarted by the watchdog."""
import logging
import subprocess
import time
import numpy as np
import helpers
from helpers import fake

from app import tts_engine, worker
from app.main import app
from app.models import db, Book
from app.pdf_reader import extract_pages
from app.storage import pdf_path

T = helpers.Results("worker")
helpers.show_database()

records = []


class Collect(logging.Handler):
    def emit(self, r):
        records.append((r.levelname, r.getMessage(), bool(r.exc_info)))


logging.getLogger("app").addHandler(Collect())


def fail_on(text):
    """Fake Kokoro behaviour for particular pages."""
    if text.strip() == "- 12 -":
        return np.concatenate([]), 24000          # what kokoro-onnx does with no phonemes
    if "ALWAYS FAILS" in text:
        raise RuntimeError("simulated Kokoro crash")
    if "FAILS ONCE" in text and not fail_on.once:
        fail_on.once = True
        raise RuntimeError("simulated one-off failure")
    assert len(text) <= tts_engine.CHUNK_CHARS, f"chunk too long: {len(text)}"
    return None


fail_on.once = False


def duration(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=format_name,duration",
                          "-of", "default=nw=1", path], capture_output=True, text=True).stdout
    vals = dict(line.split("=", 1) for line in out.split())
    return vals.get("format_name"), float(vals.get("duration", 0))


def wait_ready(book_id, timeout=120):
    def ready():
        with app.app_context():
            b = db.session.get(Book, book_id)
            return b.status == "ready" and b.pages_done
    return helpers.wait_until(ready, timeout, 0.5)


T.section("Text helpers")
T.check("'- 12 -' has digits, so it goes to Kokoro", tts_engine.is_speakable("- 12 -"))
T.check("punctuation only is not speakable", not tts_engine.is_speakable("  * * *  ...  |  "))
T.check("the no-text marker is not speakable", not tts_engine.is_speakable("[This page has no readable text]"))
T.check("letters in other scripts count", tts_engine.is_speakable("Ἀρχή") and tts_engine.is_speakable("日本"))
long_text = "".join(f"This is sentence number {i} and it goes on for a little while to fill the page. " for i in range(120))
chunks = tts_engine.split_text(long_text)
T.check("long text splits into chunks no longer than the limit", len(chunks) > 1 and all(len(c) <= tts_engine.CHUNK_CHARS for c in chunks),
        f"{len(long_text)} chars -> {len(chunks)} chunks")
T.check("chunks end at sentence ends", all(c.endswith(".") for c in chunks))
T.check("no words lost or changed", " ".join(chunks).split() == long_text.split())
nospace = "x" * 4000
T.check("text with no spaces is still cut to the limit", all(len(c) <= tts_engine.CHUNK_CHARS for c in tts_engine.split_text(nospace))
        and "".join(tts_engine.split_text(nospace)) == nospace)

PAGES = [
    "Hello there. This is a perfectly normal page of the book.",   # 1 normal
    "- 12 -",                                                       # 2 Kokoro returns no audio
    "This page ALWAYS FAILS inside Kokoro.",                        # 3 raises every time
    "This page FAILS ONCE and then works.",                         # 4 raises the first time
    "",                                                             # 5 empty page
    "* * *   . . .   |",                                            # 6 punctuation only
    long_text,                                                      # 7 very long page
    "And a normal last page.",                                      # 8 normal
]

try:
    uid = helpers.create_user("worker", helpers.password())
    book_id, key = helpers.add_book(uid, "Robust", texts=PAGES, status="processing", tall=True)
    extracted = extract_pages(pdf_path(key))
    T.check("the PDF pages extract as intended", extracted[1] == "- 12 -" and extracted[4] == "[This page has no readable text]"
            and extracted[6].split() == long_text.split())

    fake.hook = fail_on
    worker.WATCHDOG_SECONDS = 1
    worker.start_worker(app)                 # also re-queues the book (it is "processing")
    first_thread = worker._thread

    T.section("A book with bad pages")
    done = wait_ready(book_id)
    T.check("the book reaches ready with every page done", done == len(PAGES), done)
    T.check("the worker thread is still alive", worker.worker_alive() and worker._thread is first_thread)
    files = [tts_engine.get_audio_path(key, i) for i in range(len(PAGES))]
    T.check("every page has an audio file", all(files), [i for i, f in enumerate(files) if not f])
    for i, name in [(1, "'- 12 -' (no audio from Kokoro)"), (2, "always fails"), (4, "empty"), (5, "punctuation only")]:
        fmt, dur = duration(files[i])
        T.check(f"page {i + 1} {name}: an MP3 of about 5 s of silence", fmt == "mp3" and 4.9 <= dur <= 5.2, f"{fmt} {dur:.2f}s")
    for i in (0, 3, 7):
        fmt, dur = duration(files[i])
        T.check(f"page {i + 1}: real audio (1 s from the fake)", fmt == "mp3" and 0.95 <= dur <= 1.15, f"{fmt} {dur:.2f}s")
    n_long = sum(1 for c in fake.calls if "sentence number" in c)
    fmt, dur = duration(files[6])
    expect = n_long * 1.0 + (n_long - 1) * tts_engine.CHUNK_GAP + 0.06          # ffmpeg adds about 0.06 s of padding
    T.check("long page: spoken in chunks and joined into one file", n_long == len(tts_engine.split_text(extracted[6])) > 1
            and abs(dur - expect) < 0.1, f"{n_long} chunks, {dur:.2f}s, expected about {expect:.2f}s")
    T.check("empty and punctuation pages never reach Kokoro", not any(c.strip() in ("", "* * *   . . .   |") for c in fake.calls))
    T.check("the always-failing page was tried exactly twice", sum("ALWAYS FAILS" in c for c in fake.calls) == 2)
    T.check("the page that failed once worked on the retry", sum("FAILS ONCE" in c for c in fake.calls) == 2)
    no_audio = [m for _, m, _ in records if "Kokoro made no audio" in m]
    T.check("the no-audio page is logged once with book id and page", len(no_audio) == 1 and f"Book {book_id} page 2" in no_audio[0], no_audio)
    fails = [m for _, m, exc in records if "audio failed" in m and exc]
    T.check("failures logged with book id, page and traceback", len(fails) == 3 and sum(f"Book {book_id} page 3" in m for m in fails) == 2, fails)
    finish = [(lvl, m) for lvl, m, _ in records if m.startswith(f"Book {book_id} finished")]
    T.check("completion logged with the failed page count",
            finish == [("WARNING", f"Book {book_id} finished: 8 pages, 1 failed and replaced by silence")], finish)

    T.section("The worker thread dies and is restarted")

    class Die(BaseException):
        pass

    real_process = worker._process_book
    killer_id, _ = helpers.add_book(uid, "Killer", texts=["One page.", "Two page."], status="processing")

    def dying(app_, bid):
        if bid == killer_id:
            raise Die()
        return real_process(app_, bid)

    worker._process_book = dying
    worker.enqueue(killer_id)
    helpers.wait_until(lambda: not first_thread.is_alive(), 10, 0.05)
    T.check("the worker thread died (simulated)", not first_thread.is_alive())
    worker._process_book = real_process
    helpers.wait_until(lambda: worker.worker_alive() and worker._thread is not first_thread, 15)
    T.check("the watchdog started a new worker thread", worker.worker_alive() and worker._thread is not first_thread)
    T.check("the book that was in progress is re-queued and finishes", wait_ready(killer_id, 60) == 2)
    T.check("the restart is logged", any("had stopped" in m for _, m, _ in records))
    after_id, _ = helpers.add_book(uid, "After", texts=["Still working."], status="processing")
    worker.enqueue(after_id)
    T.check("a new book after the restart finishes", wait_ready(after_id, 60) == 1)
    T.check("the worker is alive at the end", worker.worker_alive())
finally:
    fake.hook = None
    n, files = helpers.cleanup()
    print(f"cleanup: deleted {n} test user(s) and the files of {files} book(s)")
T.finish()
