"""Per-user books, uploads and their checks, the page shell (htmx), the player
data, privacy between users, the queue worker, and delete."""
import os
import re
import time
import helpers
from helpers import fake, upload, login, meta_token

from app import tts_engine, worker
from app.main import app, MAX_BOOKS
from app import main as main_module
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
    # Voices: display names only; the six old ids stay valid everywhere
    from app.tts_engine import VOICES, VOICE_LABELS
    ids = ["af_heart", "af_nova", "bf_emma", "am_adam", "am_echo", "bm_george"]
    T.check("the six voice ids are unchanged, with a name and description for each",
            sorted(VOICES) == sorted(ids) and [VOICE_LABELS[i][0] for i in ids] == ["Esinam", "Enyonam", "Enam", "Elikem", "Elorm", "Eyram"]
            and all(VOICE_LABELS[i][1] for i in ids), VOICE_LABELS)
    resolved = []
    for vid in ids:
        a.post("/save_progress", json={"book_id": book_id, "page": 2, "speed": 1.25, "voice": vid}, headers={"X-CSRFToken": meta_token(a)})
        resolved.append(a.get(f"/player/{book_id}").get_json()["voice"])
    T.check("every old saved id still saves and comes back as the same id", resolved == ids, resolved)
    shell = a.get("/").get_data(as_text=True)
    T.check("the page shows the names and descriptions, with the ids only as values", all(
        f'value="{i}"' in shell and f'<span class="voice-name">{VOICE_LABELS[i][0]}</span>' in shell
        and f'<span class="voice-desc">{VOICE_LABELS[i][1]}</span>' in shell for i in ids))
    T.check("the default (af_heart) is the first choice, Esinam", shell.index('value="af_heart"') < shell.index('value="af_nova"')
            and 'value="af_heart" checked' in shell)
    a.post("/save_progress", json={"book_id": book_id, "page": 2, "speed": 1.25, "voice": "bf_emma"}, headers={"X-CSRFToken": meta_token(a)})
    for bad in ({"speed": 9}, {"voice": "../nope"}):
        r = a.post("/save_progress", json={"book_id": book_id, "page": 1, **bad}, headers={"X-CSRFToken": meta_token(a)})
        T.check(f"an unknown {list(bad)[0]} is rejected and nothing changes", r.status_code == 400
                and a.get(f"/player/{book_id}").get_json()["page"] == 2, r.status_code)
    # Positions saved offline arrive later with their time ("at"): last write wins
    import time as _time
    t0 = a.get(f"/player/{book_id}").get_json()["updated"]
    T.check("/player/<id> says when progress was saved", isinstance(t0, int) and t0 > 0, t0)
    r = a.post("/save_progress", json={"book_id": book_id, "page": 0, "speed": 1.0, "voice": "bf_emma",
               "at": int(_time.time() * 1000) - 3600_000}, headers={"X-CSRFToken": meta_token(a)})
    T.check("an older offline position is ignored", r.get_json() == {"status": "stale"}
            and a.get(f"/player/{book_id}").get_json()["page"] == 2, r.get_json())
    r = a.post("/save_progress", json={"book_id": book_id, "page": 1, "speed": 1.25, "voice": "bf_emma",
               "at": int(_time.time() * 1000) + 3600_000}, headers={"X-CSRFToken": meta_token(a)})
    j = a.get(f"/player/{book_id}").get_json()
    T.check("a newer one is saved, with its time capped at now", r.get_json() == {"status": "saved"} and j["page"] == 1
            and j["updated"] <= int(_time.time() * 1000) + 1000, j)
    r = a.post("/save_progress", json={"book_id": book_id, "page": 1, "at": "soon"}, headers={"X-CSRFToken": meta_token(a)})
    T.check("a bad time is rejected", r.status_code == 400, r.status_code)
    a.post("/save_progress", json={"book_id": book_id, "page": 2, "speed": 1.25, "voice": "bf_emma"},
           headers={"X-CSRFToken": meta_token(a)})

    T.section("Offline downloads (server side)")
    m = a.get(f"/offline/manifest/{book_id}")
    mj = m.get_json()
    T.check("manifest: details, text per page, cover and audio for the current voice", m.status_code == 200
            and mj["pages"] == 3 and len(mj["texts"]) == 3 and mj["voice"] == "bf_emma"
            and [f["url"] for f in mj["files"] if f["kind"] == "audio"] == [f"/audio/{book_id}/{i}?voice=bf_emma" for i in range(3)]
            and mj["files"][0]["url"] == f"/cover/{book_id}", {k: mj[k] for k in ("pages", "voice")} if mj else m.status_code)
    T.check("manifest: real size of each page's text, and a total that adds up", len(mj["text_bytes"]) == 3
            and mj["text_bytes"] == [len(t.encode()) for t in mj["texts"]]
            and mj["bytes"] == sum(f["bytes"] or 0 for f in mj["files"]) + sum(mj["text_bytes"]), mj["text_bytes"])
    real = {f["url"]: len(a.get(f["url"]).get_data()) for f in mj["files"] if f["bytes"] is not None}
    T.check("manifest: every file's size is what the server really sends (audio, cover, artwork)",
            real and all(real[f["url"]] == f["bytes"] for f in mj["files"] if f["bytes"] is not None),
            {u: n for u, n in real.items() if n != next(f["bytes"] for f in mj["files"] if f["url"] == u)})
    sizes = a.get(f"/offline/manifest/{book_id}?texts=0")
    sj = sizes.get_json()
    T.check("?texts=0: the same sizes without the text (for the confirm sheet)", "texts" not in sj
            and sj["text_bytes"] == mj["text_bytes"] and sj["files"] == mj["files"] and sj["bytes"] == mj["bytes"])
    T.check("the manifest is never cached", m.headers.get("Cache-Control") == "no-store"
            and sizes.headers.get("Cache-Control") == "no-store")
    busy_id, _ = helpers.add_book(a_id, "Busy", 2, status="processing")
    T.check("a book still processing can't be downloaded yet (409)", a.get(f"/offline/manifest/{busy_id}").status_code == 409
            and a.get(f"/offline/manifest/{busy_id}?texts=0").status_code == 409)
    ob = a.get("/offline/books").get_json()
    T.check("/offline/books lists the user's book ids", ob["user"] == a_id and book_id in ob["books"] and busy_id in ob["books"], ob)
    T.check("/offline/csrf gives a token that works", a.post("/save_progress", json={"book_id": book_id, "page": 2, "speed": 1.25,
            "voice": "bf_emma"}, headers={"X-CSRFToken": a.get("/offline/csrf").get_json()["token"]}).status_code == 200)
    sw = anon.get("/sw.js")
    T.check("/sw.js is public, no-cache, versioned", sw.status_code == 200 and sw.headers["Cache-Control"] == "no-cache, max-age=0"
            and "__VERSION__" not in sw.get_data(as_text=True) and "waudible-shell-" in sw.get_data(as_text=True))
    mf = anon.get("/manifest.webmanifest")
    T.check("the web app manifest is public", mf.status_code == 200 and mf.mimetype == "application/manifest+json"
            and mf.get_json()["display"] == "standalone")
    off = anon.get("/offline")
    T.check("/offline is public and holds no token or user details", off.status_code == 200
            and "csrf" not in off.get_data(as_text=True) and "waudible-user" not in off.get_data(as_text=True))
    T.check("/downloads renders for the user", a.get("/downloads").status_code == 200)

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

    T.section("Build version and asset URLs")
    from app import main as app_main
    build = app_main.BUILD
    shell = a.get("/").get_data(as_text=True)
    T.check("the build is a 12 character hash", re.fullmatch(r"[0-9a-f]{12}", build), build)
    T.check("the page carries its build", f'<meta name="waudible-build" content="{build}">' in shell)
    T.check("every CSS and JS URL carries the build", all(f'/static/{f}?v={build}"' in shell for f in
            ("css/style.css", "js/update.js", "js/htmx.min.js", "js/sheets.js", "js/offline.js", "js/player.js", "js/app.js"))
            and not re.search(r'/static/[^"?]+\.(css|js)"', shell))
    login_page = anon.get("/login").get_data(as_text=True)
    T.check("the login page too", f'/static/css/style.css?v={build}"' in login_page and f'/static/js/signed-out.js?v={build}"' in login_page)
    T.check("every response says which build made it", all(c.get(u).headers.get("X-Waudible-Build") == build
            for c, u in ((a, "/"), (a, "/library"), (anon, "/login"), (anon, "/sw.js"), (a, f"/player/{book_id}"))))
    cur = anon.get(f"/static/css/style.css?v={build}")
    T.check("a current asset is kept for a year (immutable)", cur.status_code == 200
            and cur.headers["Cache-Control"] == "public, max-age=31536000, immutable", cur.headers.get("Cache-Control"))
    for u in ("/static/css/style.css", "/static/js/player.js?v=0123456789ab"):
        r = anon.get(u)
        T.check(f"{u} (no or old version): checked every time, never kept by the CDN", r.status_code == 200
                and r.headers["Cache-Control"] == "no-cache, max-age=0" and r.headers.get("CDN-Cache-Control") == "no-store"
                and r.headers.get("Cloudflare-CDN-Cache-Control") == "no-store", r.headers.get("Cache-Control"))
    sw_src = anon.get("/sw.js").get_data(as_text=True)
    T.check("the service worker's version and cache name are the same build", f"const VERSION    = '{build}';" in sw_src)
    T.check("and it precaches the versioned URLs", f'"/static/css/style.css?v={build}"' in sw_src
            and f'"/static/js/player.js?v={build}"' in sw_src and '"/offline"' in sw_src)

    T.section("Another voice (routes)")
    t = meta_token(a)
    prep = a.post("/voice/prepare", json={"book_id": book_id, "voice": "am_echo", "page": 1}, headers={"X-CSRFToken": t})
    T.check("POST /voice/prepare queues the page", prep.status_code == 200 and prep.get_json()["voice"] == "am_echo"
            and prep.get_json()["page"] == 1 and prep.get_json()["state"] in ("queued", "working", "ready"), prep.get_json())
    helpers.wait_until(lambda: a.get(f"/voice/status/{book_id}?voice=am_echo&page=1").get_json()["state"] == "ready", 30)
    st = a.get(f"/voice/status/{book_id}?voice=am_echo&page=1")
    T.check("GET /voice/status reports it ready, not cached", st.get_json()["state"] == "ready" and st.headers["Cache-Control"] == "no-store")
    T.check("the page after it is made too (pages ahead)", helpers.wait_until(
            lambda: a.get(f"/voice/status/{book_id}?voice=am_echo&page=2").get_json()["state"] == "ready", 30))
    T.check("a page before it wasn't asked for", a.get(f"/voice/status/{book_id}?voice=am_echo&page=0").get_json()["state"] == "none")
    T.check("its audio is the voice's own file", a.get(f"/audio/{book_id}/1?voice=am_echo").status_code == 200
            and tts_engine.get_audio_path(key, 1, "am_echo"))
    bad = [a.post("/voice/prepare", json=j, headers={"X-CSRFToken": t}).status_code for j in (
        {"book_id": book_id, "voice": "../x", "page": 0}, {"book_id": book_id, "voice": "Elorm", "page": 0},
        {"book_id": book_id, "voice": "am_echo", "page": 3}, {"book_id": book_id, "voice": "am_echo", "page": -1},
        {"book_id": book_id, "voice": "am_echo"}, {"book_id": "x", "voice": "am_echo", "page": 0})]
    T.check("unknown voices (names too), pages out of range and bad ids -> 400", bad == [400] * 6, bad)
    T.check("status: unknown voice or page -> 400", [a.get(u).status_code for u in (f"/voice/status/{book_id}?voice=x&page=0",
            f"/voice/status/{book_id}?voice=am_echo&page=9", f"/voice/status/{book_id}?voice=am_echo")] == [400] * 3)
    T.check("POST /voice/prepare needs the CSRF token", a.post("/voice/prepare", json={"book_id": book_id, "voice": "am_echo",
            "page": 0}).status_code == 400)

    T.section("Page audio: no database round trips once the owner check is known")
    from sqlalchemy import event as sa_event
    from sqlalchemy.engine import Engine
    from app import media_cache
    queries = []
    count = lambda *args: queries.append(args[2])
    sa_event.listen(Engine, "before_cursor_execute", count)
    try:
        media_cache.clear()
        queries.clear()
        first = a.get(f"/audio/{book_id}/0")
        n_first = len(queries)
        queries.clear()
        again = [a.get(f"/audio/{book_id}/{p}") for p in (0, 1, 2, 0)]
        T.check("the first request checks the user and the owner in the database", first.status_code == 200 and n_first >= 2, n_first)
        T.check("the next ones send the page with no database query at all", all(r.status_code == 200 for r in again)
                and len(queries) == 0, len(queries))
        T.check("and the same bytes", again[3].get_data() == first.get_data())
        queries.clear()
        T.check("other routes still look the user up every time", a.get(f"/player/{book_id}").status_code == 200
                and any("from users" in q.lower() for q in queries))
    finally:
        sa_event.remove(Engine, "before_cursor_execute", count)
    b_tmp = helpers.HttpsClient(app)
    login(b_tmp, "books_b", PW)
    T.check("another user still gets 404, even with the owner's lookup remembered", b_tmp.get(f"/audio/{book_id}/0").status_code == 404)
    T.check("logged out still goes to the login page", anon.get(f"/audio/{book_id}/0").status_code == 302)
    T.check("a page out of range is still refused", a.get(f"/audio/{book_id}/99").status_code == 400)
    # A book deleted while its lookup is remembered is refused at once
    gone_id, gone_key = helpers.add_book(a_id, "Gone Soon", 2, ready_pages=2)
    T.check("a second book plays", a.get(f"/audio/{gone_id}/0").status_code == 200)
    T.check("deleting it", a.post(f"/delete/{gone_id}", data={"csrf_token": meta_token(a)}).status_code == 302)
    T.check("its audio is 404 straight away", a.get(f"/audio/{gone_id}/0").status_code == 404)
    gone2_id, gone2_key = helpers.add_book(a_id, "Gone Behind", 2, ready_pages=2)
    a.get(f"/audio/{gone2_id}/0")
    from app.tts_engine import delete_book_audio
    delete_book_audio(gone2_key)          # deleted elsewhere, the remembered lookup not yet forgotten
    T.check("audio of a book whose files are being deleted is 404 even if remembered", a.get(f"/audio/{gone2_id}/0").status_code == 404)
    lo = helpers.HttpsClient(app)
    login(lo, "books_a", PW)
    lo.get(f"/audio/{book_id}/0")
    lo.post("/logout", data={"csrf_token": meta_token(lo)})
    T.check("after logging out the same browser is sent to login", lo.get(f"/audio/{book_id}/0").status_code == 302)
    # Making a page on demand takes a while: the database connection goes back first
    seen = {}
    real_tta = main_module.text_to_audio

    def slow_tta(*args, **kwargs):
        seen["checked_out"] = db.engine.pool.checkedout()
        return real_tta(*args, **kwargs)

    main_module.text_to_audio = slow_tta
    media_cache.clear()                   # so this request does query the database first
    try:
        r = a.get(f"/audio/{book_id}/1?voice=am_adam")
    finally:
        main_module.text_to_audio = real_tta
    T.check("while a page is made on demand, no database connection is held", r.status_code == 200 and seen.get("checked_out") == 0, seen)

    T.section("Privacy: user B asks for user A's book")
    login(b, "books_b", PW)
    t = meta_token(b)
    gets = [f"/read/{book_id}", f"/player/{book_id}", f"/audio/{book_id}/0", f"/cover/{book_id}", f"/cover/{book_id}?size=96",
            f"/toc/{book_id}", f"/status/{book_id}", f"/readiness/{book_id}", f"/page_text/{book_id}/0",
            f"/offline/manifest/{book_id}", f"/offline/manifest/{book_id}?texts=0"]
    for u in gets:
        code = b.get(u).status_code
        T.check(f"B GET {u} -> 404", code == 404, code)
    T.check("B POST /delete -> 404", b.post(f"/delete/{book_id}", data={"csrf_token": t}).status_code == 404)
    T.check("B POST /voice/prepare -> 404", b.post("/voice/prepare", json={"book_id": book_id, "voice": "am_adam", "page": 0},
            headers={"X-CSRFToken": t}).status_code == 404)
    T.check("B GET /voice/status -> 404", b.get(f"/voice/status/{book_id}?voice=am_echo&page=1").status_code == 404)
    T.check("B POST /save_progress -> 404", b.post("/save_progress", json={"book_id": book_id, "page": 0}, headers={"X-CSRFToken": t}).status_code == 404)
    T.check("a book id that doesn't exist is the same 404", b.get("/read/999999999").status_code == 404)
    with app.app_context():
        bk = db.session.get(Book, book_id)
        T.check("A's book, files and progress untouched", bk is not None and bk.progress.current_page == 2 and os.path.exists(pdf_path(key)))
    home_b = b.get("/").get_data(as_text=True)
    T.check("B's pages don't list A's books", f'data-open-book="{book_id}"' not in home_b and "No books yet" in home_b)

    T.section("Logged out")
    for u in ["/", "/library", "/downloads", "/offline/books", "/offline/csrf", f"/voice/status/{book_id}?voice=am_echo&page=1", *gets]:
        r = anon.get(u)
        T.check(f"GET {u} -> login", r.status_code == 302 and r.location.startswith("/login?next="), f"{r.status_code} {r.location}")
    for u, kw in ((f"/delete/{book_id}", {}), ("/save_progress", {"json": {"book_id": book_id, "page": 0}}), ("/upload", {}),
                  ("/voice/prepare", {"json": {"book_id": book_id, "voice": "am_echo", "page": 0}})):
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
