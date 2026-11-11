"""Shared setup for every test suite. Import this before anything from app.

- Refuses to run against the production database (see tests/README.md).
- Uses throwaway SECRET_KEY and INVITE_CODE values, never the real ones.
- Keeps all files in a temporary data folder, never the real data/.
- Replaces Kokoro with a fake, so no model files are needed and tests are fast.
"""
import atexit
import io
import os
import re
import secrets
import shutil
import signal
import sys
import tempfile
import time
from urllib.parse import urlsplit

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(ROOT)

# Every test user's email starts with this, so cleanup can find them all
PREFIX = "zz_test_"


# ─────────────────────────────────────────
# GUARD: NEVER THE PRODUCTION DATABASE
# ─────────────────────────────────────────
def _endpoint(url: str | None) -> str | None:
    """Neon endpoint id of a connection string (the pooled and direct hosts share it)."""
    if not url:
        return None
    host = urlsplit(url).hostname or ""
    return host.split(".")[0].removesuffix("-pooler") or None


def _refuse(reason: str):
    sys.stderr.write(
        "\nREFUSING TO RUN THE TESTS: " + reason + "\n"
        "Tests write to the database, so they only run on a temporary Neon branch.\n"
        "Create one and export its connection strings for the test run only, for example:\n\n"
        "  neon branches create --name tests-$(date +%Y%m%d) --parent production --schema-only \\\n"
        "      --expires-at <tomorrow>T23:59:59Z --no-secrets\n"
        "  export DATABASE_URL=\"$(neon cs tests-<date> --pooled)\"\n"
        "  export DATABASE_URL_UNPOOLED=\"$(neon cs tests-<date>)\"\n\n"
        "See tests/README.md. Never edit .env for this.\n\n")
    sys.exit(2)


def guard():
    url, direct = os.environ.get("DATABASE_URL"), os.environ.get("DATABASE_URL_UNPOOLED")
    if not url or not direct:
        _refuse("DATABASE_URL and DATABASE_URL_UNPOOLED are not set in the environment "
                "(without them the app would use the production values in .env).")
    production = set()
    env_file = os.path.join(ROOT, ".env")
    if os.path.exists(env_file):
        from dotenv import dotenv_values
        values = dotenv_values(env_file)
        production = {_endpoint(values.get(k)) for k in ("DATABASE_URL", "DATABASE_URL_UNPOOLED")} - {None}
    if os.environ.get("WAUDIBLE_PRODUCTION_ENDPOINT"):
        production.add(os.environ["WAUDIBLE_PRODUCTION_ENDPOINT"])
    if {_endpoint(url), _endpoint(direct)} & production:
        _refuse("DATABASE_URL points at the production database host.")
    if _endpoint(url) != _endpoint(direct):
        _refuse("DATABASE_URL and DATABASE_URL_UNPOOLED point at different databases.")


guard()

# A timeout (SIGTERM from run_tests.sh) ends the suite like an error, so its
# finally: blocks still delete the test users and files
signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))


# ─────────────────────────────────────────
# THROWAWAY SETTINGS AND A TEMPORARY DATA FOLDER
# Set before the app loads (load_dotenv never overrides these)
# ─────────────────────────────────────────
os.environ["SECRET_KEY"] = secrets.token_hex(32)
os.environ["INVITE_CODE"] = INVITE_CODE = "test-invite-" + secrets.token_hex(6)
for _flag in ("WAUDIBLE_DEBUG", "WAUDIBLE_SECURE_COOKIES"):
    os.environ.pop(_flag, None)          # production defaults unless a suite says otherwise

if not os.environ.get("WAUDIBLE_DATA_DIR"):
    _tmp = tempfile.mkdtemp(prefix="waudible-test-data-")
    os.environ["WAUDIBLE_DATA_DIR"] = _tmp
    atexit.register(shutil.rmtree, _tmp, True)
DATA_DIR = os.environ["WAUDIBLE_DATA_DIR"]


# ─────────────────────────────────────────
# FAKE KOKORO
# Returns a tone of fake.seconds per call (silence if quiet). Set
# fake.delay to slow it down, or fake.hook(text) to raise or return
# something else for particular text.
# ─────────────────────────────────────────
import numpy as np
import kokoro_onnx

RATE = 24000


class FakeKokoro:
    def __init__(self, *args, **kwargs):
        self.seconds, self.delay, self.quiet, self.hook = 1.0, 0.0, False, None
        self.calls = []

    def create(self, text, voice, speed):
        self.calls.append(text)
        if self.delay:
            time.sleep(self.delay)
        if self.hook:
            result = self.hook(text)
            if result is not None:
                return result
        n = int(RATE * self.seconds)
        if self.quiet:
            return np.zeros(n, dtype=np.float32), RATE
        t = np.arange(n) / RATE
        return (0.2 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), RATE


kokoro_onnx.Kokoro = FakeKokoro

from app import tts_engine                 # noqa: E402  (after the fake is in place)
fake = tts_engine.kokoro


# ─────────────────────────────────────────
# RESULTS
# ─────────────────────────────────────────
class Results:
    def __init__(self, name: str):
        self.name, self.passed, self.failed = name, 0, 0

    def check(self, label, ok, detail=""):
        ok = bool(ok)
        print(f"{'PASS' if ok else 'FAIL'}  {label}" + (f"  [{detail}]" if detail not in ("", None) else ""), flush=True)
        if ok:
            self.passed += 1
        else:
            self.failed += 1
        return ok

    def section(self, title):
        print(f"== {title} ==", flush=True)

    def finish(self):
        """Print the summary line run_tests.sh reads, then exit without waiting for threads."""
        print(f"RESULT {self.name}: {self.passed} passed, {self.failed} failed", flush=True)
        sys.stdout.flush()
        os._exit(1 if self.failed else 0)


def show_database():
    print("test database endpoint:", _endpoint(os.environ["DATABASE_URL"]), flush=True)


# ─────────────────────────────────────────
# FIXTURES
# ─────────────────────────────────────────
def password() -> str:
    return "Pw-" + secrets.token_urlsafe(12)


def make_pdf(pages: int = 3, texts=None, toc=None, tall: bool = False) -> bytes:
    import fitz
    doc = fitz.open()
    texts = texts if texts is not None else [
        f"Page {i + 1}. It is the small decisions you make every day that add up over time." for i in range(pages)]
    for t in texts:
        page = doc.new_page(width=595, height=842 * (4 if tall else 1))
        if t:
            page.insert_textbox(fitz.Rect(36, 36, 559, page.rect.height - 36), t, fontsize=9 if tall else 11)
    if toc:
        doc.set_toc(toc)
    return doc.tobytes()


def png(width=8, height=8, rgb=(40, 60, 110)) -> bytes:
    import fitz
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, width, height), False)
    pix.set_rect(pix.irect, rgb)
    return pix.tobytes("png")


def create_user(name: str, pw: str, display_name: str | None = None):
    """A test user straight in the database. Returns its id."""
    from app.main import app
    from app.models import db, User
    with app.app_context():
        u = User(email=f"{PREFIX}{name}@example.com", display_name=display_name or f"Test {name}")
        u.set_password(pw)
        db.session.add(u)
        db.session.commit()
        return u.id


def email(name: str) -> str:
    return f"{PREFIX}{name}@example.com"


def add_book(user_id: int, title: str, pages: int = 3, *, texts=None, toc=None, cover_rgb=None,
             author="Test Author", genre="Fiction", status="ready", current_page=0, ready_pages=0, tall=False):
    """A book straight in the database with its PDF (and cover) on disk. Returns (id, storage_key)."""
    from app.main import app
    from app.models import db, Book, Progress
    from app.storage import pdf_path, cover_path, new_storage_key
    key = new_storage_key()
    data = make_pdf(pages, texts=texts, toc=toc, tall=tall)
    with open(pdf_path(key), "wb") as f:
        f.write(data)
    cover = None
    if cover_rgb:
        cover = f"{key}.png"
        with open(cover_path(cover), "wb") as f:
            f.write(png(160, 210, cover_rgb))
    n_pages = len(texts) if texts is not None else pages
    with app.app_context():
        b = Book(user_id=user_id, storage_key=key, original_name=f"{title[:40]}.pdf", title=title, author=author,
                 pages=n_pages, genre=genre, cover=cover, status=status,
                 pages_done=n_pages if status == "ready" else 0, progress=Progress(current_page=current_page))
        db.session.add(b)
        db.session.commit()
        book_id = b.id
    for i in range(ready_pages):
        tts_engine.text_to_audio("x", key, page=i)
    return book_id, key


class HttpsClient:
    """Flask test client over https with a same-site Referer, as the browser
    sends behind the tunnel (Secure cookies and Flask-WTF's referrer check)."""

    def __new__(cls, app):
        from flask.testing import FlaskClient

        class _Client(FlaskClient):
            def open(self, *args, **kwargs):
                kwargs.setdefault("base_url", "https://localhost")
                headers = dict(kwargs.get("headers") or {})
                headers.setdefault("Referer", "https://localhost/")
                kwargs["headers"] = headers
                return super().open(*args, **kwargs)

        app.test_client_class = _Client
        return app.test_client()


FORM_TOKEN = re.compile(r'name="csrf_token" (?:type="hidden" )?value="([^"]+)"')
META_TOKEN = re.compile(r'name="csrf-token" content="([^"]+)"')


def form_token(client, path="/login", headers=None) -> str:
    return FORM_TOKEN.search(client.get(path, headers=headers or {}).get_data(as_text=True)).group(1)


def meta_token(client) -> str:
    return META_TOKEN.search(client.get("/").get_data(as_text=True)).group(1)


def login(client, name_or_email: str, pw: str, headers=None):
    addr = name_or_email if "@" in name_or_email else email(name_or_email)
    t = form_token(client, "/login", headers)
    return client.post("/login", data={"email": addr, "password": pw, "csrf_token": t}, headers=headers or {})


def upload(client, pdf_bytes, name="book.pdf", cover=None, genre="Fiction"):
    """Upload through the real form. Returns (response, flash messages shown afterwards)."""
    data = {"csrf_token": meta_token(client), "genre": genre, "pdf": (io.BytesIO(pdf_bytes), name)}
    if cover:
        data["cover"] = (io.BytesIO(cover[0]), cover[1])
    r = client.post("/upload", data=data, content_type="multipart/form-data")
    page = client.get("/").get_data(as_text=True)
    return r, re.findall(r'class="auth-alert upload-alert">([^<]*)<', page)


def wait_until(fn, timeout=60, interval=0.2):
    end = time.time() + timeout
    while time.time() < end:
        value = fn()
        if value:
            return value
        time.sleep(interval)
    return fn()


def cleanup():
    """Delete every test user (books and progress go with them) and their files."""
    from app.main import app
    from app.models import db, User, Book
    from app.storage import remove_book_files
    with app.app_context():
        users = User.query.filter(User.email.like(f"{PREFIX}%")).all()
        books = Book.query.filter(Book.user_id.in_([u.id for u in users])).all() if users else []
        files = [(b.storage_key, b.cover) for b in books]
        n = User.query.filter(User.email.like(f"{PREFIX}%")).delete(synchronize_session=False)
        db.session.commit()
    for key, cover in files:
        tts_engine.delete_book_audio(key)
        remove_book_files(key, cover)
    return n, len(files)
