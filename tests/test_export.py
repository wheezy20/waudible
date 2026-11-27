"""Save to device: one MP3 per chapter, page range or whole book, joined
from the page MP3s with ID3 tags, cover artwork and chapter markers;
filenames, owner-only access, incomplete chapters refused, the build cap
and no leftover files."""
import json
import os
import subprocess
import threading
import time
import helpers
from helpers import fake

from app import export, tts_engine
from app.main import app
from app.limiter import limiter
from app.storage import EXPORTS_DIR

limiter.enabled = False          # the export limit has its own check in test_prod.py
T = helpers.Results("export")
helpers.show_database()
PW = helpers.password()


def probe(data: bytes) -> dict:
    path = os.path.join(helpers.DATA_DIR, "probe.mp3")
    with open(path, "wb") as f:
        f.write(data)
    out = subprocess.run(["ffprobe", "-v", "error", "-show_format", "-show_streams", "-show_chapters", "-of", "json", path],
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def leftovers():
    return os.listdir(EXPORTS_DIR)


try:
    a_id = helpers.create_user("export_a", PW, "Export A")
    helpers.create_user("export_b", PW, "Export B")
    toc = [[1, "Introduction", 1], [1, "Chapter 2: Grit / Growth?", 3], [1, "The End", 5]]
    # Pages of different lengths (1.2 s, 1.7 s, ...), so the duration check means something
    title = 'Grit: The Power of "Passion" / Perseverance'
    book_id, key = helpers.add_book(a_id, title, 6, toc=toc, cover_rgb=(30, 80, 160), author="Angela Duckworth",
                                    genre="Self Help")
    for i in range(6):
        fake.seconds = 1.2 + 0.5 * i
        tts_engine.text_to_audio(f"Page {i} text.", key, page=i)
    fake.seconds = 1.0
    page_lengths = [export.duration(tts_engine.get_audio_path(key, i)) for i in range(6)]
    # Ready up to page 3 only (chapter 3 is incomplete), no cover
    part_id, part_key = helpers.add_book(a_id, "Half Done", 6, toc=toc, ready_pages=3)

    a, b, anon = helpers.HttpsClient(app), helpers.HttpsClient(app), helpers.HttpsClient(app)
    helpers.login(a, "export_a", PW)
    helpers.login(b, "export_b", PW)

    T.section("Filenames")
    T.check("book, track number and chapter", export.file_name("Grit", "Chapter title", 3, 12) == "Grit - 03 Chapter title.mp3")
    T.check("three digits when there are 100 or more chapters", export.file_name("Grit", "x", 7, 120) == "Grit - 007 x.mp3")
    T.check("a page range and the whole book", export.file_name("Grit", "Pages 12 to 20") == "Grit - Pages 12 to 20.mp3"
            and export.file_name("Grit", None) == "Grit.mp3")
    cases = {'a/b\\c:d*e?f"g<h>i|j': "a b c d e f g h i j", "../../etc/passwd": "etc passwd", "  ..hidden.. ": "hidden",
             "tab\there\nnew\x00line\x7f": "tab here new line", "Café Œuvre, naïve": "Café Œuvre, naïve", "": "",
             "x" * 300: "x" * 120}
    got = {k: export.safe_name(k) for k in cases}
    T.check("unsafe characters, control characters, dots and length are cleaned; accents stay", got == cases,
            {k[:20]: v for k, v in got.items() if v != cases[k]})
    T.check("an empty title still gives a name", export.file_name("///", "") == "Book - Part.mp3")

    T.section("What can be saved (info)")
    info = a.get(f"/export/{book_id}/info").get_json()
    chs = info["chapters"]
    T.check("three chapters from the contents", [c["title"] for c in chs] == ["Introduction", "Chapter 2: Grit / Growth?", "The End"]
            and [(c["start"], c["end"]) for c in chs] == [(0, 1), (2, 3), (4, 5)], chs)
    sizes = [os.path.getsize(tts_engine.get_audio_path(key, i)) for i in range(6)]
    T.check("each with its real size and ready", all(c["ready"] for c in chs)
            and [c["bytes"] for c in chs] == [sizes[0] + sizes[1], sizes[2] + sizes[3], sizes[4] + sizes[5]])
    T.check("the default voice is the listener's", info["voice"] == "af_heart" and info["whole"]["ready"]
            and info["whole"]["bytes"] == sum(sizes))
    T.check("sanitised names", chs[1]["name"] == "Grit The Power of Passion Perseverance - 02 Chapter 2 Grit Growth.mp3"
            and info["whole"]["name"] == "Grit The Power of Passion Perseverance.mp3", chs[1]["name"])
    pinfo = a.get(f"/export/{part_id}/info").get_json()
    T.check("an unfinished book: complete chapters ready, the rest not", [c["ready"] for c in pinfo["chapters"]] == [True, False, False]
            and pinfo["ready_pages"] == 3 and not pinfo["whole"]["ready"], pinfo["chapters"])

    T.section("One chapter")
    chk = a.get(f"/export/{book_id}/check?chapter=1").get_json()
    T.check("check gives the name and size", chk == {"name": chs[1]["name"], "bytes": chs[1]["bytes"], "pages": 2}, chk)
    r = a.get(f"/export/{book_id}/file?chapter=1")
    body = r.get_data()
    cd = r.headers.get("Content-Disposition", "")
    T.check("an MP3 download with the filename", r.status_code == 200 and r.mimetype == "audio/mpeg"
            and cd.startswith("attachment;") and 'filename="Grit The Power of Passion Perseverance - 02 Chapter 2 Grit Growth.mp3"' in cd, cd)
    T.check("Content-Length matches, never cached", r.headers.get("Content-Length") == str(len(body))
            and r.headers.get("Cache-Control") == "no-store" and r.headers.get("CDN-Cache-Control") == "no-store")
    p = probe(body)
    tags = p["format"].get("tags", {})
    T.check("ID3 tags: title (chapter), album (book), artist (author), track, genre",
            tags.get("title") == "Chapter 2: Grit / Growth?" and tags.get("album") == title and tags.get("artist") == "Angela Duckworth"
            and tags.get("track") == "2/3" and tags.get("genre") == "Audiobook", tags)
    audio = [s for s in p["streams"] if s["codec_type"] == "audio"]
    pic = [s for s in p["streams"] if s["codec_type"] == "video"]
    T.check("the audio is the pages' MP3, copied (mono, 24 kHz)", len(audio) == 1 and audio[0]["codec_name"] == "mp3"
            and audio[0]["channels"] == 1 and audio[0]["sample_rate"] == "24000", audio)
    T.check("the cover is embedded as front cover artwork (600x600 JPEG)", len(pic) == 1 and pic[0]["codec_name"] == "mjpeg"
            and pic[0]["disposition"]["attached_pic"] == 1 and (pic[0]["width"], pic[0]["height"]) == (600, 600)
            and pic[0].get("tags", {}).get("comment") == "Cover (front)", pic)
    dur = float(p["format"]["duration"])
    want = page_lengths[2] + page_lengths[3]
    T.check("its length is the sum of its pages", abs(dur - want) < 0.05, f"{dur:.3f} vs {want:.3f}")
    T.check("a chapter marker at each page", [(c["tags"]["title"], round(float(c["start_time"]), 2)) for c in p["chapters"]]
            == [("Page 3", 0.0), ("Page 4", round(page_lengths[2], 2))], p["chapters"])
    T.check("no files left behind", leftovers() == [], leftovers())

    T.section("The whole book as one file, and a page range")
    r = a.get(f"/export/{book_id}/file?whole=1")
    p = probe(r.get_data())
    tags = p["format"].get("tags", {})
    T.check("named after the book, no track number", r.status_code == 200
            and 'filename="Grit The Power of Passion Perseverance.mp3"' in r.headers["Content-Disposition"]
            and tags.get("title") == title and "track" not in tags, tags)
    T.check("length is the sum of all six pages", abs(float(p["format"]["duration"]) - sum(page_lengths)) < 0.05,
            f'{p["format"]["duration"]} vs {sum(page_lengths):.3f}')
    T.check("a chapter marker at each chapter", [c["tags"]["title"] for c in p["chapters"]] == [c["title"] for c in chs]
            and abs(float(p["chapters"][1]["start_time"]) - sum(page_lengths[:2])) < 0.01, p["chapters"])
    r = a.get(f"/export/{book_id}/file?pages=2-5")
    p = probe(r.get_data())
    T.check("pages 2 to 5: named, titled and as long as those pages", r.status_code == 200
            and 'filename="Grit The Power of Passion Perseverance - Pages 2 to 5.mp3"' in r.headers["Content-Disposition"]
            and p["format"]["tags"].get("title") == "Pages 2 to 5" and len(p["chapters"]) == 4
            and abs(float(p["format"]["duration"]) - sum(page_lengths[1:5])) < 0.05)
    r = a.get(f"/export/{part_id}/file?chapter=0")
    pic = [s for s in probe(r.get_data())["streams"] if s["codec_type"] == "video"]
    T.check("a book without a cover gets the initials artwork", r.status_code == 200 and len(pic) == 1
            and pic[0]["disposition"]["attached_pic"] == 1)
    T.check("still no files left behind", leftovers() == [], leftovers())

    T.section("Incomplete and bad requests are refused")
    for q in ("chapter=1", "chapter=2", "whole=1", "pages=3-5"):
        for route in ("check", "file"):
            r = a.get(f"/export/{part_id}/{route}?{q}")
            msg = (r.get_json() or {}).get("error", "")
            T.check(f"{route} ?{q} on an unfinished book -> 409 with a clear message",
                    r.status_code == 409 and "isn't ready to save yet" in msg and "pages have audio" in msg, f"{r.status_code} {msg}")
    msg = a.get(f"/export/{part_id}/check?chapter=1").get_json()["error"]
    T.check("the message names the chapter and counts the pages", msg.startswith('"Chapter 2: Grit / Growth?" isn\'t ready')
            and "1 of 2 pages" in msg, msg)
    T.check("another voice with no audio yet -> 409", a.get(f"/export/{book_id}/check?chapter=0&voice=bf_emma").status_code == 409)
    bad = {q: a.get(f"/export/{book_id}/file?{q}").status_code for q in
           ("chapter=3", "chapter=-1", "chapter=x", "pages=0-2", "pages=5-2", "pages=1-7", "pages=abc", "", "voice=xx&chapter=0",
            "voice=Esinam&chapter=0")}
    T.check("unknown chapters, pages and voices -> 400", set(bad.values()) == {400}, bad)

    T.section("Owner only, login required")
    for route in ("info", "check?chapter=0", "file?chapter=0", "file?whole=1"):
        r = b.get(f"/export/{book_id}/{route}")
        T.check(f"another user: /export/<id>/{route} -> 404", r.status_code == 404, r.status_code)
        r = anon.get(f"/export/{book_id}/{route}")
        T.check(f"logged out: /export/<id>/{route} -> login", r.status_code == 302 and r.location.startswith("/login"), r.status_code)
    T.check("a book that doesn't exist -> 404", a.get("/export/999999999/file?chapter=0").status_code == 404)

    T.section("At most one build at a time")
    real_ffmpeg = export._ffmpeg
    live, peak = [0], [0]
    lock = threading.Lock()

    def slow_ffmpeg(args, timeout=600):
        with lock:
            live[0] += 1
            peak[0] = max(peak[0], live[0])
        try:
            time.sleep(1.5)
            return real_ffmpeg(args, timeout)
        finally:
            with lock:
                live[0] -= 1

    export._ffmpeg = slow_ffmpeg
    try:
        export.WAIT_SECONDS = 0.5
        second_client = helpers.HttpsClient(app)          # signed in first: a slow login mustn't outlast the build
        helpers.login(second_client, "export_a", PW)
        results = {}
        first = threading.Thread(target=lambda: results.update(first=a.get(f"/export/{book_id}/file?chapter=0")))
        first.start()
        helpers.wait_until(lambda: live[0] > 0, 10, 0.02)
        T.check("while a build runs, its folder exists", len(leftovers()) == 1, leftovers())
        busy = second_client.get(f"/export/{book_id}/file?chapter=2")
        first.join(30)
        T.check("a second build that can't get a slot in time -> 503, asked to try again",
                busy.status_code == 503 and "try again" in busy.get_json()["error"], busy.status_code)
        T.check("the first build finishes normally", results["first"].status_code == 200)
        export.WAIT_SECONDS = 30
        peak[0] = 0
        out = {}
        threads = [threading.Thread(target=lambda n=n: out.update({n: (c := helpers.HttpsClient(app), helpers.login(c, "export_a", PW),
                                                                         c.get(f"/export/{book_id}/file?chapter={n}"))[2]})) for n in range(3)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(60)
        T.check("three at once: all succeed, one after another (never two builds together)",
                all(out[n].status_code == 200 for n in range(3)) and peak[0] == 1, f"peak {peak[0]}")
    finally:
        export._ffmpeg = real_ffmpeg
        export.WAIT_SECONDS = 30
    T.check("no files left behind after the queue", leftovers() == [], leftovers())

    T.section("Failures and cancelled downloads leave nothing behind")

    def broken(args, timeout=600):
        raise subprocess.CalledProcessError(1, "ffmpeg", stderr=b"simulated failure")

    export._ffmpeg = broken
    try:
        r = a.get(f"/export/{book_id}/file?chapter=0")
    finally:
        export._ffmpeg = real_ffmpeg
    T.check("an ffmpeg failure -> 500 with a message, nothing left", r.status_code == 500
            and "couldn't be made" in r.get_json()["error"] and leftovers() == [], r.status_code)
    r = a.get(f"/export/{book_id}/file?whole=1", buffered=False)
    first_bytes = next(iter(r.response))
    r.close()
    T.check("a download stopped after the first bytes leaves nothing behind", first_bytes[:3] == b"ID3" and leftovers() == [])
    os.makedirs(os.path.join(EXPORTS_DIR, "build-crashed"), exist_ok=True)
    export.clear_leftovers()
    T.check("builds left by a crash are removed at startup", leftovers() == [])
    T.check("the slot is free again afterwards", a.get(f"/export/{book_id}/file?chapter=0").status_code == 200)

    T.section("Several chapters as one ZIP")
    import io
    import zipfile
    chk = a.get(f"/export/{book_id}/check?chapters=0,2").get_json()
    T.check("check: name, size and number of files", chk.get("name") == "Grit The Power of Passion Perseverance - 2 chapters.zip"
            and chk.get("files") == 2 and chk.get("bytes") == chs[0]["bytes"] + chs[2]["bytes"], chk)
    T.check("next to each other: Chapters 1 to 2; all of them: All chapters",
            a.get(f"/export/{book_id}/check?chapters=0,1").get_json()["name"].endswith(" - Chapters 1 to 2.zip")
            and a.get(f"/export/{book_id}/check?chapters=all").get_json()["name"].endswith(" - All chapters.zip"))
    r = a.get(f"/export/{book_id}/zip?chapters=all")
    body = r.get_data()
    T.check("one ZIP download with its filename, never cached", r.status_code == 200 and r.mimetype == "application/zip"
            and 'filename="Grit The Power of Passion Perseverance - All chapters.zip"' in r.headers["Content-Disposition"]
            and r.headers.get("Content-Length") == str(len(body)) and r.headers.get("Cache-Control") == "no-store")
    z = zipfile.ZipFile(io.BytesIO(body))
    infos = z.infolist()
    T.check("one MP3 per chapter, named like a single save", [i.filename for i in infos] == [c["name"] for c in chs], [i.filename for i in infos])
    T.check("entries are stored, not compressed", all(i.compress_type == zipfile.ZIP_STORED for i in infos))
    T.check("the ZIP is intact", z.testzip() is None)
    p = probe(z.read(infos[1].filename))
    T.check("each entry is the same tagged MP3 with artwork", p["format"]["tags"].get("title") == "Chapter 2: Grit / Growth?"
            and p["format"]["tags"].get("track") == "2/3" and any(s["disposition"].get("attached_pic") == 1 for s in p["streams"])
            and abs(float(p["format"]["duration"]) - (page_lengths[2] + page_lengths[3])) < 0.05)
    T.check("no files left behind after the ZIP", leftovers() == [], leftovers())
    bad = {q: a.get(f"/export/{book_id}/zip?{q}").status_code for q in ("chapters=", "chapters=3", "chapters=-1", "chapters=x", "chapters=0,9")}
    T.check("unknown chapters -> 400", set(bad.values()) == {400}, bad)
    r = a.get(f"/export/{part_id}/zip?chapters=0,1")
    T.check("a chapter that isn't ready refuses the whole ZIP with the same message", r.status_code == 409
            and "isn't ready to save yet" in r.get_json()["error"], r.status_code)
    T.check("another user: 404; logged out: login", b.get(f"/export/{book_id}/zip?chapters=all").status_code == 404
            and anon.get(f"/export/{book_id}/zip?chapters=all").status_code == 302)
    T.check("still nothing left behind", leftovers() == [], leftovers())

    T.section("Service worker")
    sw = anon.get("/sw.js").get_data(as_text=True)
    T.check("the worker leaves /export/ alone (the browser's own download)", "url.pathname.startsWith('/export/')) return;" in sw)
finally:
    n, files = helpers.cleanup()
    print(f"cleanup: deleted {n} test user(s) and the files of {files} book(s)")
T.finish()
