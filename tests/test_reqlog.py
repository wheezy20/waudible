"""Slow request logging (route pattern only, nothing private) and database
connect error logging (hosts, addresses, users and database names masked)."""
import logging
import os
import re
import secrets
import time
from urllib.parse import urlsplit, urlunsplit, quote
import psycopg
import sqlalchemy as sa
import helpers
from helpers import fake, meta_token

from flask import abort, request
from app import request_log
from app.main import app
from app.limiter import limiter

limiter.enabled = False
T = helpers.Results("reqlog")
helpers.show_database()
PW = helpers.password()

lines = []


class Collect(logging.Handler):
    def emit(self, r):
        lines.append(self.format(r))


_collector = Collect()
_collector.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))   # as the journal gets them
logging.getLogger("app").addHandler(_collector)


def slow(since):
    return [l for l in lines[since:] if "Slow request" in l]


def connect_errors(since):
    return [l for l in lines[since:] if "Database connect error" in l]


# Test-only routes (added before the first request)
@app.route("/zz_slow/<int:tenths>")
def zz_slow(tenths):
    time.sleep(tenths / 10)
    return "ok"


@app.route("/zz_missing/<int:book_id>")
def zz_missing(book_id):
    time.sleep(3.2)
    abort(404)


@app.route("/zz_crash")
def zz_crash():
    time.sleep(3.2)
    raise RuntimeError("boom")


@app.route("/zz_post", methods=["POST"])
def zz_post():
    time.sleep(3.2)
    return "posted " + str(len(request.form))


try:
    uid = helpers.create_user("reqlog", PW, "Reqlog Test")
    book_id, _ = helpers.add_book(uid, "Reqlog Book", texts=["A page to read aloud."])
    c = helpers.HttpsClient(app)
    T.check("logged in", helpers.login(c, "reqlog", PW).status_code == 302)
    token = meta_token(c)
    cookie = c.get_cookie("session").value
    EMAIL = helpers.email("reqlog")

    T.section("Slow and fast requests")
    n = len(lines); c.get("/zz_slow/5")
    T.check("a fast request logs nothing", slow(n) == [], slow(n))
    n = len(lines); t0 = time.perf_counter(); c.get("/zz_slow/10"); took = time.perf_counter() - t0
    T.check("a 1 s request (well under the limit even on a slow database) logs nothing", slow(n) == [], f"{took:.2f}s {slow(n)}")
    n = len(lines); c.get("/zz_slow/32?token=SECRETTOKEN987&email=" + quote(EMAIL))
    got = slow(n)
    T.check("a request over 3 s logs exactly one line", len(got) == 1, got)
    line = got[0] if got else ""
    T.check("WARNING with method, route pattern, status and seconds",
            re.fullmatch(r"WARNING app\.request_log: Slow request: GET /zz_slow/<int:tenths> 200 in \d+\.\d\d s", line), line)
    T.check("no real path, query string, token or email", all(s not in line for s in ("/zz_slow/32", "SECRETTOKEN987", "token", EMAIL, "?")), line)

    fake.delay = 3.3
    n = len(lines); r = c.get(f"/audio/{book_id}/0?voice=af_heart")
    fake.delay = 0
    got = slow(n)
    T.check("a real slow route (audio made on demand) is logged by its pattern", r.status_code == 200 and len(got) == 1
            and "GET /audio/<int:book_id>/<int:page> 200 in " in got[0] and f"/audio/{book_id}/" not in got[0] and "af_heart" not in got[0], got)
    n = len(lines); r = c.get("/zz_missing/424242")
    got = slow(n)
    T.check("a slow 404 is logged with its status and no id", r.status_code == 404 and len(got) == 1
            and " GET /zz_missing/<int:book_id> 404 in " in got[0] and "424242" not in got[0], got)
    n = len(lines); r = c.get("/zz_crash")
    got = slow(n)
    T.check("a slow request that crashes is logged with status 500", r.status_code == 500 and len(got) == 1 and " GET /zz_crash 500 in " in got[0], got)
    n = len(lines)
    r = c.post("/zz_post", data={"email": EMAIL, "password": "BodyPassword123", "note": "private words"}, headers={"X-CSRFToken": token})
    everything = "\n".join(lines[n:])
    T.check("a slow POST is logged with method and pattern only", r.status_code == 200 and len(slow(n)) == 1 and " POST /zz_post 200 in " in slow(n)[0])
    T.check("no body, password, email, cookie, token or name in anything logged",
            all(s not in everything for s in (EMAIL, "BodyPassword123", "private words", cookie, token, PW, "Reqlog Test")), lines[n:])

    T.section("Unmatched and static paths (limit lowered to 0 for these)")
    request_log.SLOW_REQUEST_SECONDS = 0
    n = len(lines); c.get("/no/such/page/31337?token=ABCSECRET")
    got = slow(n)
    T.check("a path with no route shows as '(no matching route)'", len(got) == 1 and "GET (no matching route) 404 in " in got[0]
            and "31337" not in got[0] and "ABCSECRET" not in got[0], got)
    n = len(lines); c.get("/static/js/app.js")
    got = slow(n)
    T.check("static files are logged by pattern", len(got) == 1 and "GET /static/<path:filename> 200" in got[0] and "app.js" not in got[0], got)
    request_log.SLOW_REQUEST_SECONDS = 3.0

    T.section("Database connect errors")
    n = len(lines)
    bad = sa.create_engine("postgresql+psycopg://zzuser:zzsecretpw@127.0.0.1:1/zzdb", connect_args={"connect_timeout": 3})
    try:
        with bad.connect():
            pass
    except sa.exc.OperationalError:
        pass
    got = connect_errors(n)
    T.check("refused connection: one ERROR line", len(got) == 1 and got[0].startswith("ERROR app.request_log: Database connect error: OperationalError: "), got)
    T.check("no host, address, user, password or database name in it", got and all(s not in got[0] for s in ("127.0.0.1", "zzuser", "zzsecretpw", "zzdb")), got)

    real = urlsplit(os.environ["DATABASE_URL"])
    wrong_pw = "Wrong" + secrets.token_hex(6)
    wrong = urlunsplit(("postgresql+psycopg", f"{real.username}:{wrong_pw}@{real.hostname}", real.path, real.query, ""))
    n = len(lines)
    try:
        with sa.create_engine(wrong, connect_args={"connect_timeout": 10}).connect():
            pass
    except sa.exc.OperationalError:
        pass
    got = connect_errors(n)
    endpoint = real.hostname.split(".")[0].removesuffix("-pooler")
    leaks = [name for name, s in (("host", real.hostname), ("endpoint id", endpoint), ("user", real.username),
             ("wrong password", wrong_pw), ("password", real.password), ("database", real.path.strip("/"))) if s and got and s in got[0]]
    T.check("the test branch with a wrong password: one ERROR line, nothing from the connection string",
            len(got) == 1 and not leaks, f"leaks={leaks}" if leaks else (got[0][:150] if got else "no line"))

    real_connect = psycopg.connect

    def failing(*a, **k):
        raise psycopg.OperationalError(f'connection to server at "{real.hostname}" (10.1.2.3), port 5432 failed: timeout expired')

    with app.app_context():
        from app.models import db
        db.engine.dispose()
    psycopg.connect = failing
    n = len(lines)
    try:
        r = c.get("/library")
    finally:
        psycopg.connect = real_connect
    got = connect_errors(n)
    T.check("a request during a database outage: the friendly 500 page and a connect error line",
            r.status_code == 500 and "Something went wrong on our side" in r.get_data(as_text=True) and got and "timeout expired" in got[0], got[:1])
    T.check("that line hides the host and address", got and real.hostname not in got[0] and "10.1.2.3" not in got[0], got[:1])
    with app.app_context():
        db.engine.dispose()
    T.check("the app recovers once the database is back", c.get("/library").status_code == 200)
finally:
    n, files = helpers.cleanup()
    print(f"cleanup: deleted {n} test user(s) and the files of {files} book(s)")
T.finish()
