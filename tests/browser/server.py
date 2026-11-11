"""Runs one headless Chrome check against the real app.

    python tests/browser/server.py nav_check.js

Seeds a test user and three books, serves the app on a free port on
127.0.0.1 (plain http, fake Kokoro making 30 s silent pages), runs the
script with node, counts its PASS and FAIL lines, and cleans up."""
import os
import socket
import subprocess
import sys
import threading

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
import helpers                                       # noqa: E402  (guard first)
from helpers import fake                             # noqa: E402

os.environ["WAUDIBLE_SECURE_COOKIES"] = "0"          # plain http on 127.0.0.1, this process only
from app.main import app                             # noqa: E402
from app.limiter import limiter                      # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
script = sys.argv[1]
name = os.path.splitext(script)[0]
T = helpers.Results(f"browser {name}")
helpers.show_database()
limiter.enabled = False
fake.seconds, fake.quiet = 30, True

server = None
try:
    pw = helpers.password()
    uid = helpers.create_user("browser", pw, "Eyram Wilson")
    toc = [[1, "Introduction: My Story", 1], [1, "The Fundamentals", 3], [2, "The Man Who Didn't Look Right", 13],
           [2, "The Best Way to Start a New Habit", 16], [1, "The 2nd Law: Make It Attractive", 20]]
    b1, _ = helpers.add_book(uid, "Atomic Habits: An Easy and Proven Way to Build Good Habits", 40, toc=toc,
                             cover_rgb=(40, 60, 110), author="James Clear", genre="Self Help", current_page=14, ready_pages=18)
    b2, _ = helpers.add_book(uid, "Mere Christianity", 3, author="C. S. Lewis", genre="Christian", ready_pages=3)
    b3, _ = helpers.add_book(uid, "Delete Me Later", 3, cover_rgb=(110, 40, 60), genre="Christian", ready_pages=3)
    extra = {}
    if name == "offline_check":
        # Finished books to download, and a second account on the same browser
        b4, _ = helpers.add_book(uid, "Offline Story", 4, toc=[[1, "Chapter One", 1], [1, "Chapter Two", 3]],
                                 cover_rgb=(30, 90, 70), author="Ada Writer", genre="Fiction", ready_pages=4)
        b5, _ = helpers.add_book(uid, "Second Story", 3, author="Ben Writer", genre="Fiction", ready_pages=3)
        b6, _ = helpers.add_book(uid, "Third Story", 2, author="Cy Writer", genre="Fiction", ready_pages=2)
        pw2 = helpers.password()
        uid2 = helpers.create_user("browser2", pw2, "Second Person")
        b7, _ = helpers.add_book(uid2, "Someone Else's Book", 2, genre="Fiction", ready_pages=2)
        extra = {"BOOK4": str(b4), "BOOK5": str(b5), "BOOK6": str(b6), "BOOK7": str(b7),
                 "EMAIL2": helpers.email("browser2"), "PASSWORD2": pw2}
    upload_pdf = os.path.join(helpers.DATA_DIR, "upload_test.pdf")
    with open(upload_pdf, "wb") as f:
        f.write(helpers.make_pdf(2))

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    from werkzeug.serving import make_server
    server = make_server("127.0.0.1", port, app, threaded=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    env = {**os.environ, "BASE_URL": f"http://127.0.0.1:{port}", "BOOK1": str(b1), "BOOK2": str(b2), "BOOK3": str(b3),
           "EMAIL": helpers.email("browser"), "PASSWORD": pw, "UPLOAD_PDF": upload_pdf, "OUT_DIR": helpers.DATA_DIR,
           "SHOT_DIR": os.environ.get("SHOT_DIR") or helpers.DATA_DIR, **extra}
    proc = subprocess.Popen(["node", os.path.join(HERE, script)], env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True)
    for line in proc.stdout:
        line = line.rstrip("\n")
        if line.startswith("PASS  "):
            T.passed += 1
        elif line.startswith("FAIL  "):
            T.failed += 1
        print(line, flush=True)
    if proc.wait() != 0 and not T.failed:
        T.check("node script exited cleanly", False, f"exit code {proc.returncode}")
finally:
    if server:
        server.shutdown()
    fake.delay = 3600       # park the worker: nothing new is written while files are removed
    n, files = helpers.cleanup()
    print(f"cleanup: deleted {n} test user(s) and the files of {files} book(s)")
T.finish()
