"""Per-user books, uploads and their checks, the page shell (htmx), the player
data, privacy between users, the queue worker, and delete."""
import os
import re
import time
import helpers
from helpers import fake, upload, login, meta_token

from app import worker
from app.main import app, MAX_BOOKS
from app.limiter import limiter
from app.models import db, Book, Progress
from app.storage import pdf_path, cover_path, audio_dir, BOOKS_DIR, COVERS_DIR, AUDIO_DIR

limiter.enabled = False
T = helpers.Results("books")
helpers.show_database()
PW = helpers.password()
HX = {"HX-Request": "true"}


def rows(user_id):
    with app.app_context():
        return [(b.id, b.storage_key, b.status, b.pages_done, b.original_name)
                for b in Book.query.filter_by(user_id=user_id).order_by(Book.id)]


def status(c, book_id):
    return c.get(f"/status/{book_id}").get_json()


def wait_done(c, book_id, timeout=60):
    return helpers.wait_until(lambda: (s := status(c, book_id)) and not s["running"] and s, timeout) or status(c, book_id)


def files_everywhere():
    return {d: sorted(os.listdir(d)) for d in (BOOKS_DIR, COVERS_DIR, AUDIO_DIR)}


try:
    a_id = helpers.create_user("books_a", PW, "Reader A")
    b_id = helpers.create_user("books_b", PW, "Reader B")
    # A book left "processing" by an earlier run, two of three pages done
    restart_id, restart_key = helpers.add_book(a_id, "Restart", 3, status="processing", ready_pages=2)

    a, b, anon = helpers.HttpsClient(app), helpers.HttpsClient(app), helpers.HttpsClient(app)

    T.section("Startup re-queue")
    login(a, "books_a", PW)              # the first request starts the worker
    s = wait_done(a, restart_id)
    T.check("a book left in 'processing' is re-queued and finishes", s == {"total": 3, "done": 3, "running": False}, s)

    T.section("Upload, processing and audio")
    r, msgs = upload(a, helpers.make_pdf(3), name="../../My Book.pdf", cover=(helpers.png(), "cover.PNG"))
    book_id, key, *_ = rows(a_id)[-1]
    T.check("upload accepted", r.status_code == 302 and msgs == [], f"{r.status_code} {msgs}")
    T.check("storage_key is 32 random hex characters", re.fullmatch(r"[0-9a-f]{32}", key), key)
    with app.app_context():
        bk = db.session.get(Book, book_id)
        T.check("PDF and cover stored under the storage_key", os.path.exists(pdf_path(key)) and bk.cover == f"{key}.png"
                and os.path.exists(cover_path(bk.cover)))
    T.check("the uploaded filename is never used as a path", not any("My Book" in n for names in files_everywhere().values() for n in names))
    s = wait_done(a, book_id)
    T.check("background processing reaches ready", s == {"total": 3, "done": 3, "running": False}, s)
    T.check("one MP3 per page in data/audio/<key>/", sorted(os.listdir(audio_dir(key))) == [f"page{i}_vaf_heart.mp3" for i in range(3)],
            sorted(os.listdir(audio_dir(key))))
    r = a.get(f"/audio/{book_id}/1?voice=af_heart")
    T.check("audio for a ready page is MP3", r.status_code == 200 and r.mimetype == "audio/mpeg", f"{r.status_code} {r.mimetype}")
    r = a.get(f"/audio/{book_id}/2?voice=bf_emma")
    T.check("another voice is made on demand", r.status_code == 200 and os.path.exists(os.path.join(audio_dir(key), "page2_vbf_emma.mp3")))
    T.check("a page past the end is rejected", a.get(f"/audio/{book_id}/3").status_code == 400)
    r = a.get(f"/audio/{book_id}/0?voice=../../etc")
    T.check("an unknown voice is rejected", r.status_code == 400, r.status_code)
    T.check("cover, toc, readiness and page text work for the owner",
            [a.get(u).status_code for u in (f"/cover/{book_id}", f"/toc/{book_id}", f"/readiness/{book_id}", f"/page_text/{book_id}/0")] == [200] * 4)
    art = a.get(f"/cover/{book_id}?size=512")
    T.check("square lock-screen artwork", art.status_code == 200 and art.mimetype == "image/png")
    T.check("artwork sizes other than 96, 192 and 512 are rejected", a.get(f"/cover/{book_id}?size=300").status_code == 400)

    T.section("Progress and the player data")
    r = a.post("/save_progress", json={"book_id": book_id, "page": 2, "speed": 1.25, "voice": "bf_emma"},
               headers={"X-CSRFToken": meta_token(a)})
    T.check("progress saved", r.status_code == 200, r.status_code)
    j = a.get(f"/player/{book_id}").get_json()
    T.check("/player/<id> resumes at the saved page, speed and voice",
            (j["page"], j["speed"], j["voice"], j["pages"], j["running"], j["cover"]) == (2, 1.25, "bf_emma", 3, False, f"/cover/{book_id}"), j)
    r = a.post("/save_progress", json={"book_id": book_id, "page": 3}, headers={"X-CSRFToken": meta_token(a)})
    T.check("a page past the end is not saved", r.status_code == 400, r.status_code)
    for bad in ({"speed": 9}, {"voice": "../nope"}):
        r = a.post("/save_progress", json={"book_id": book_id, "page": 1, **bad}, headers={"X-CSRFToken": meta_token(a)})
        T.check(f"an unknown {list(bad)[0]} is rejected and nothing changes", r.status_code == 400
                and a.get(f"/player/{book_id}").get_json()["page"] == 2, r.status_code)
    home = a.get("/").get_data(as_text=True)
    T.check("Home shows the book on its shelf and in Continue listening", "Fiction" in home and "Continue listening" in home
            and f'data-open-book="{book_id}"' in home)

    T.section("Page shell (htmx)")
    for path in ("/", "/library", f"/read/{book_id}"):
        full, frag = a.get(path), a.get(path, headers=HX)
        fb, gb = full.get_data(as_text=True), frag.get_data(as_text=True)
        T.check(f"{path}: a normal load gets the whole shell", '<audio id="audio-player"' in fb and 'id="mini-player"' in fb and "htmx.min.js" in fb)
        T.check(f"{path}: htmx gets only the content", "<audio" not in gb and 'id="app-content"' not in gb and 'class="page"' in gb)
        T.check(f"{path}: Vary and HX-Push-Url headers", "HX-Request" in frag.headers.get("Vary", "") and frag.headers.get("HX-Push-Url") == path)
        rest = a.get(path, headers={**HX, "HX-History-Restore-Request": "true"})
        T.check(f"{path}: a history restore gets the whole page", 'id="app-content"' in rest.get_data(as_text=True))
    T.check("/read/<id> asks the player to open the book", f'data-open-book="{book_id}"' in a.get(f"/read/{book_id}", headers=HX).get_data(as_text=True))
    T.check("/library has the shelves but not Continue listening",
            "Continue listening" not in (lib := a.get("/library", headers=HX).get_data(as_text=True)) and "Your library" in lib)
    r = anon.get("/library", headers=HX)
    T.check("logged out htmx request gets HX-Redirect to login", r.status_code == 204 and r.headers.get("HX-Redirect", "").startswith("/login?next="))

    T.section("Privacy: user B asks for user A's book")
    login(b, "books_b", PW)
    t = meta_token(b)
    gets = [f"/read/{book_id}", f"/player/{book_id}", f"/audio/{book_id}/0", f"/cover/{book_id}", f"/cover/{book_id}?size=96",
            f"/toc/{book_id}", f"/status/{book_id}", f"/readiness/{book_id}", f"/page_text/{book_id}/0"]
    for u in gets:
        code = b.get(u).status_code
        T.check(f"B GET {u} -> 404", code == 404, code)
    T.check("B POST /delete -> 404", b.post(f"/delete/{book_id}", data={"csrf_token": t}).status_code == 404)
    T.check("B POST /save_progress -> 404", b.post("/save_progress", json={"book_id": book_id, "page": 0}, headers={"X-CSRFToken": t}).status_code == 404)
    T.check("a book id that doesn't exist is the same 404", b.get("/read/999999999").status_code == 404)
    with app.app_context():
        bk = db.session.get(Book, book_id)
        T.check("A's book, files and progress untouched", bk is not None and bk.progress.current_page == 2 and os.path.exists(pdf_path(key)))
    home_b = b.get("/").get_data(as_text=True)
    T.check("B's pages don't list A's books", f'data-open-book="{book_id}"' not in home_b and "No books yet" in home_b)

    T.section("Logged out")
    for u in ["/", "/library", *gets]:
        r = anon.get(u)
        T.check(f"GET {u} -> login", r.status_code == 302 and r.location.startswith("/login?next="), f"{r.status_code} {r.location}")
    for u, kw in ((f"/delete/{book_id}", {}), ("/save_progress", {"json": {"book_id": book_id, "page": 0}}), ("/upload", {})):
        r = anon.post(u, **kw)
        T.check(f"POST {u} -> login", r.status_code == 302 and r.location.startswith("/login"), f"{r.status_code} {r.location}")

    T.section("Upload checks")
    before = files_everywhere(); n_before = len(rows(a_id))
    r, msgs = upload(a, b"Hello, I am a text file pretending to be a PDF.", name="fake.pdf")
    T.check("a non-PDF named .pdf is rejected", msgs == ["That file is not a PDF."], msgs)
    r, msgs = upload(a, b"%PDF-1.7 but then nothing that PyMuPDF can open", name="broken.pdf")
    T.check("a broken PDF is rejected", msgs == ["That PDF could not be read."], msgs)
    r, msgs = upload(a, helpers.make_pdf(1), cover=(b"GIF89a....", "cover.png"))
    T.check("a cover that isn't really a PNG is rejected", msgs == ["Cover images must be JPG, PNG or WebP."], msgs)
    r, msgs = upload(a, helpers.make_pdf(1), cover=(helpers.png() + b"\0" * (5 * 1024 * 1024), "big.png"))
    T.check("a cover over 5 MB is rejected", msgs == ["Cover images can be at most 5 MB."], msgs)
    big = b"%PDF-1.7\n" + b"\0" * (100 * 1024 * 1024)
    r, msgs = upload(a, big, name="huge.pdf")
    del big
    T.check("a file over 100 MB is rejected", r.status_code == 302 and msgs == ["That file is too large. PDFs can be at most 100 MB."], msgs)
    T.check("rejected uploads left no files and no rows", files_everywhere() == before and len(rows(a_id)) == n_before)

    with app.app_context():
        for i in range(MAX_BOOKS - n_before):
            db.session.add(Book(user_id=a_id, storage_key=f"{i:032x}", original_name=f"filler{i}.pdf",
                                title=f"Filler {i}", pages=1, status="ready", pages_done=1))
        db.session.commit()
    r, msgs = upload(a, helpers.make_pdf(1), name="one-too-many.pdf")
    T.check(f"book number {MAX_BOOKS + 1} is rejected", msgs == [f"You can have at most {MAX_BOOKS} books. Delete one to upload another."]
            and len(rows(a_id)) == MAX_BOOKS, msgs)
    with app.app_context():
        Book.query.filter(Book.user_id == a_id, Book.original_name.like("filler%")).delete(synchronize_session=False)
        db.session.commit()

    T.section("Queue order and delete while processing")
    fake.delay = 1.0
    upload(a, helpers.make_pdf(12), name="slow.pdf")
    upload(a, helpers.make_pdf(2), name="second.pdf")
    (slow_id, slow_key, *_), (second_id, *_) = rows(a_id)[-2:]
    helpers.wait_until(lambda: status(a, slow_id)["done"] >= 2, 60)
    s2 = status(a, second_id)
    T.check("the second upload waits while the first is processed", s2["done"] == 0 and s2["running"], s2)
    token = meta_token(a)
    s1 = status(a, slow_id)
    r = a.post(f"/delete/{slow_id}", data={"csrf_token": token})
    T.check("delete while the book is still being processed", r.status_code == 302 and s1["running"] and s1["done"] < 12, f"{r.status_code} {s1}")
    time.sleep(2.5)
    T.check("its files stay gone after the worker's next page", not os.path.exists(audio_dir(slow_key)) and not os.path.exists(pdf_path(slow_key)))
    fake.delay = 0.0
    T.check("the worker carries on with the next book", wait_done(a, second_id) == {"total": 2, "done": 2, "running": False})
    T.check("the worker thread is still alive", worker.worker_alive())

    T.section("Delete")
    r = a.post(f"/delete/{book_id}", data={"csrf_token": meta_token(a)})
    with app.app_context():
        gone = db.session.get(Book, book_id) is None and Progress.query.filter_by(book_id=book_id).count() == 0
    T.check("delete goes back home", r.status_code == 302 and r.location == "/", f"{r.status_code} {r.location}")
    T.check("book and progress rows gone", gone)
    T.check("PDF, cover and audio gone", not os.path.exists(pdf_path(key)) and not os.path.exists(cover_path(f"{key}.png"))
            and not os.path.exists(audio_dir(key)))
    T.check("the deleted book is now 404 for its owner too", a.get(f"/read/{book_id}").status_code == 404)
finally:
    n, files = helpers.cleanup()
    print(f"cleanup: deleted {n} test user(s) and the files of {files} book(s)")
T.finish()
