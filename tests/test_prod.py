"""Production settings: debug off, cookies, security headers, rate limits by real
client address, error pages, the gunicorn settings, and a real gunicorn
started on a spare port (with the real Kokoro when the model files exist)."""
import os
import re
import signal
import socket
import subprocess
import sys
import time
import urllib.request
import helpers
from helpers import ROOT, form_token

from app.main import app
from app.models import db, Book

T = helpers.Results("prod")
helpers.show_database()
PW = helpers.password()


@app.route("/__test_boom")
def __test_boom():
    return 1 / 0


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


gunicorn = None
try:
    helpers.create_user("prod", PW, "Prod Tester")

    T.section("Settings")
    T.check("debug off by default", app.debug is False)
    T.check("cookies are Secure, HttpOnly and SameSite=Lax by default",
            (app.config["SESSION_COOKIE_SECURE"], app.config["SESSION_COOKIE_HTTPONLY"], app.config["SESSION_COOKIE_SAMESITE"]) == (True, True, "Lax"))
    probe = ("import os, sys; sys.path.insert(0, 'tests'); import helpers; "
             "os.environ.update(dict(a.split('=') for a in sys.argv[1:])); "
             "from app.main import app; print(app.debug, app.config['SESSION_COOKIE_SECURE'])")
    for flags, want in [([], "False True"), (["WAUDIBLE_SECURE_COOKIES=0"], "False False"), (["WAUDIBLE_DEBUG=1"], "True True")]:
        r = subprocess.run([sys.executable, "-c", probe, *flags], capture_output=True, text=True, cwd=ROOT)
        got = r.stdout.strip().splitlines()[-1] if r.stdout.strip() else r.stderr.strip()[-200:]
        T.check(f"{' '.join(flags) or 'no flags'}: debug and secure cookies are {want}", got == want, got)
    conf = open(os.path.join(ROOT, "gunicorn.conf.py")).read()
    T.check("gunicorn.conf.py: one worker process", re.search(r"^workers\s*=\s*1\b", conf, re.M))
    T.check("gunicorn.conf.py: bound to 127.0.0.1:8000 only", re.search(r'^bind\s*=\s*"127\.0\.0\.1:8000"', conf, re.M) and "0.0.0.0" not in conf.split("#")[0])
    service = open(os.path.join(ROOT, "deploy", "waudible.service")).read()
    T.check("the systemd unit doesn't turn on debug or insecure cookies", "WAUDIBLE_DEBUG" not in service and "WAUDIBLE_SECURE_COOKIES" not in service)

    T.section("Cookies and headers")
    c = helpers.HttpsClient(app)
    r = c.get("/login")
    attrs = [x.strip().lower() for x in r.headers.get("Set-Cookie", "").split(";")[1:]]
    T.check("session cookie is Secure, HttpOnly and SameSite=Lax", {"secure", "httponly", "samesite=lax"} <= set(attrs), attrs)
    want = {"X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "strict-origin-when-cross-origin"}
    for path in ("/login", "/static/css/style.css", "/no-such-page"):
        h = c.get(path).headers
        T.check(f"security headers on {path}", all(h.get(k) == v for k, v in want.items()) and "Content-Security-Policy" in h)
    csp = r.headers["Content-Security-Policy"]
    T.check("CSP: own scripts only, no eval, no framing, no plugins", "script-src 'self' 'unsafe-inline'" in csp and "unsafe-eval" not in csp
            and "frame-ancestors 'none'" in csp and "object-src 'none'" in csp, csp)

    T.section("Rate limits (real client address from the tunnel's X-Forwarded-For)")
    rl = helpers.HttpsClient(app)
    ip = {"X-Forwarded-For": "203.0.113.7"}
    t = form_token(rl, "/login", ip)
    codes = [rl.post("/login", data={"email": helpers.email("nobody"), "password": "wrong-pass", "csrf_token": t}, headers=ip).status_code
             for _ in range(11)]
    T.check("10 login attempts allowed, the 11th gets 429", codes[:10] == [400] * 10 and codes[10] == 429, codes)
    r = rl.post("/login", data={"email": "x@example.com", "password": "x", "csrf_token": t}, headers={"X-Forwarded-For": "9.9.9.9, 203.0.113.7"})
    T.check("a spoofed first X-Forwarded-For value is ignored", r.status_code == 429, r.status_code)
    r = rl.post("/login", data={"email": "x@example.com", "password": "x", "csrf_token": t}, headers={"X-Forwarded-For": "203.0.113.8"})
    T.check("another client address is not limited", r.status_code == 400, r.status_code)
    body = rl.post("/login", data={"csrf_token": t}, headers=ip).get_data(as_text=True)
    T.check("the 429 page is friendly", "Slow down a little" in body)
    T.check("GET /login is never limited", rl.get("/login", headers=ip).status_code == 200)
    reg = {"X-Forwarded-For": "203.0.113.9"}
    t = form_token(rl, "/register", reg)
    codes = [rl.post("/register", data={"csrf_token": t, "email": "bad"}, headers=reg).status_code for _ in range(11)]
    T.check("10 sign-up attempts allowed, the 11th gets 429", codes[:10] == [400] * 10 and codes[10] == 429, codes)

    T.section("Error pages")
    e = helpers.HttpsClient(app)
    h = {"X-Forwarded-For": "198.51.100.1"}
    helpers.login(e, "prod", PW, h)
    for path in ("/read/999999999", "/no-such-page"):
        r = e.get(path, headers=h)
        T.check(f"404 page for {path}", r.status_code == 404 and "Page not found" in r.get_data(as_text=True), r.status_code)
    r = e.get("/__test_boom", headers=h)
    b = r.get_data(as_text=True)
    T.check("500 page", r.status_code == 500 and "Something went wrong on our side" in b, r.status_code)
    T.check("the 500 page shows no stack trace", not any(w in b for w in ("Traceback", "ZeroDivisionError", 'File "', "werkzeug")))
    r = e.post("/save_progress", json={"book_id": 1, "page": 0}, headers=h)
    T.check("400 page (missing CSRF token)", r.status_code == 400 and "Something went wrong with that request" in r.get_data(as_text=True))
    big = b"x" * (100 * 1024 * 1024 + 1)
    r = helpers.HttpsClient(app).post("/login", data=big, content_type="application/x-www-form-urlencoded", headers={"X-Forwarded-For": "198.51.100.2"})
    del big
    T.check("413 page", r.status_code == 413 and "That file is too large" in r.get_data(as_text=True), r.status_code)

    T.section("gunicorn (on a spare port; production keeps 8000)")
    if not all(os.path.exists(os.path.join(ROOT, f)) for f in ("kokoro-v1.0.onnx", "voices-v1.0.bin")):
        print("SKIP  gunicorn checks: the app loads the real Kokoro at startup and the model files are not in the repo root")
    else:
        uid = helpers.create_user("prod_g", PW)
        gbook, gkey = helpers.add_book(uid, "Gunicorn", texts=["Hello from gunicorn."], status="processing")
        port = free_port()
        log_path = os.path.join(helpers.DATA_DIR, "gunicorn.log")
        with open(log_path, "w") as log:
            gunicorn = subprocess.Popen([os.path.join(ROOT, "venv", "bin", "gunicorn"), "--config", "gunicorn.conf.py",
                                         "--bind", f"127.0.0.1:{port}"], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT,
                                        start_new_session=True, env={**os.environ})
        with open(os.path.join(helpers.DATA_DIR, "gunicorn.pid"), "w") as f:
            f.write(str(gunicorn.pid))           # run_tests.sh stops it if this suite is killed
        up = helpers.wait_until(lambda: not subprocess.run(["bash", "-c", f"exec 3<>/dev/tcp/127.0.0.1/{port}"], capture_output=True).returncode, 90, 1)
        T.check(f"gunicorn is listening on 127.0.0.1:{port}", up)
        def ready():
            with app.app_context():
                db.session.expire_all()
                return db.session.get(Book, gbook).status == "ready"
        T.check("an unfinished book is re-queued and made with the real Kokoro before any request", helpers.wait_until(ready, 120, 1))
        from app.storage import audio_dir
        T.check("its page is an MP3", os.listdir(audio_dir(gkey)) == ["page0_vaf_heart.mp3"], os.listdir(audio_dir(gkey)))
        try:
            resp = urllib.request.urlopen(f"http://127.0.0.1:{port}/login", timeout=15)
            code, hdrs = resp.status, resp.headers
        except Exception as ex:
            code, hdrs = str(ex), {}
        T.check("GET /login -> 200", code == 200, code)
        T.check("served with security headers and a Secure, HttpOnly cookie", hdrs.get("X-Frame-Options") == "DENY"
                and "Secure" in hdrs.get("Set-Cookie", "") and "HttpOnly" in hdrs.get("Set-Cookie", ""))
        listen = [l for l in subprocess.run(["ss", "-ltn"], capture_output=True, text=True).stdout.splitlines() if f":{port} " in l]
        T.check("bound to 127.0.0.1 only, not 0.0.0.0", listen and all(f"127.0.0.1:{port}" in l for l in listen), listen)
        procs = subprocess.run(["pgrep", "-s", str(gunicorn.pid)], capture_output=True, text=True).stdout.split()
        T.check("one master and exactly one worker process", len(procs) == 2, f"{len(procs)} processes")
finally:
    if gunicorn:
        os.killpg(gunicorn.pid, signal.SIGTERM)
        try:
            gunicorn.wait(timeout=60)
        except subprocess.TimeoutExpired:
            os.killpg(gunicorn.pid, signal.SIGKILL)
    n, files = helpers.cleanup()
    print(f"cleanup: deleted {n} test user(s) and the files of {files} book(s)")
T.finish()
