import hashlib
import json
import logging
import os
from datetime import datetime, timezone
from flask import (Flask, render_template, request, abort, flash,
                   send_file, redirect, url_for, jsonify, make_response)
from flask_login import current_user
from flask_wtf.csrf import CSRFProtect, generate_csrf
from werkzeug.middleware.proxy_fix import ProxyFix
from app.pdf_reader import extract_page, extract_pages, get_book_info, extract_toc
from app.tts_engine import (text_to_audio, get_audio_path,
                            delete_book_audio, VOICES, SPEEDS)
from app.storage import (new_storage_key, pdf_path, cover_path,
                         remove_book_files)
from app.artwork import ARTWORK_SIZES, cover_artwork, fallback_artwork
from app.worker import enqueue, start_worker
from app.config import database_url
from app.models import db, Book, Progress
from app.auth import auth, login_manager
from app.limiter import limiter, UPLOAD_LIMIT
from app.request_log import init_request_logging

app = Flask(__name__)

# Messages from the app's own modules (worker, audio) go to stderr, which
# systemd keeps in the journal (journalctl -u waudible)
_app_log = logging.getLogger("app")
if not _app_log.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
    _app_log.addHandler(_handler)
    _app_log.setLevel(logging.INFO)
    _app_log.propagate = False

# Slow requests and database connect errors go to the same log. Set up
# before any other hook, so the timer covers the login check too.
init_request_logging(app)


def _env_flag(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None or value.strip() == "":
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


# Debug is off unless WAUDIBLE_DEBUG=1 (only ever for local development)
DEBUG = _env_flag("WAUDIBLE_DEBUG", False)
# Secure cookies are on unless WAUDIBLE_SECURE_COOKIES=0 (local http testing)
SECURE_COOKIES = _env_flag("WAUDIBLE_SECURE_COOKIES", True)

# Behind the Cloudflare Tunnel: trust one proxy hop for the client
# address, scheme and host. gunicorn listens on 127.0.0.1 only, so
# these headers can only come from cloudflared on this machine.
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

# ─────────────────────────────────────────
# CONFIG (secrets come from .env)
# ─────────────────────────────────────────
SECRET_KEY = os.environ.get("SECRET_KEY")
if not SECRET_KEY:
    raise RuntimeError("SECRET_KEY is not set in .env (see .env.example)")
app.config["SECRET_KEY"] = SECRET_KEY
app.config["DEBUG"]      = DEBUG

# Session cookie: not readable by JavaScript, not sent on cross-site
# requests, and only over HTTPS in production
app.config["SESSION_COOKIE_HTTPONLY"]  = True
app.config["SESSION_COOKIE_SAMESITE"]  = "Lax"
app.config["SESSION_COOKIE_SECURE"]    = SECURE_COOKIES
app.config["REMEMBER_COOKIE_HTTPONLY"] = True
app.config["REMEMBER_COOKIE_SAMESITE"] = "Lax"
app.config["REMEMBER_COOKIE_SECURE"]   = SECURE_COOKIES
app.config["PREFERRED_URL_SCHEME"]     = "https" if SECURE_COOKIES else "http"

# The page shell (player, sheets) stays loaded while you listen, so its
# CSRF token must not expire after an hour. It stays tied to the session.
app.config["WTF_CSRF_TIME_LIMIT"] = None

# Pooled Neon URL for the running app. PgBouncer runs in transaction
# mode, so server-side prepared statements stay off.
app.config["SQLALCHEMY_DATABASE_URI"]   = database_url()
app.config["SQLALCHEMY_ENGINE_OPTIONS"] = {
    "pool_pre_ping": True,
    "connect_args" : {"prepare_threshold": None},
}

# Largest upload request (the PDF plus an optional cover)
MAX_PDF_BYTES   = 100 * 1024 * 1024
MAX_COVER_BYTES = 5 * 1024 * 1024
MAX_BOOKS       = 20
app.config["MAX_CONTENT_LENGTH"] = MAX_PDF_BYTES

db.init_app(app)
login_manager.init_app(app)
app.register_blueprint(auth)

# Cover types, checked by content (magic bytes), not just the extension
COVER_TYPES = {
    "jpg" : lambda head: head.startswith(b"\xff\xd8\xff"),
    "png" : lambda head: head.startswith(b"\x89PNG\r\n\x1a\n"),
    "webp": lambda head: head[:4] == b"RIFF" and head[8:12] == b"WEBP",
}

PRESET_GENRES = [
    "Self Help", "Academic", "Christian", "Lecture Slides",
    "Fiction", "Biography", "Technology", "Other"
]

# The PWA files hold no user data, so they load without a session
PUBLIC_ENDPOINTS = {"auth.login", "auth.register", "static",
                    "web_manifest", "service_worker", "offline_page"}


# ─────────────────────────────────────────
# LOGIN REQUIRED EVERYWHERE
# New routes are private by default
# ─────────────────────────────────────────
@app.before_request
def require_login():
    start_worker(app)   # no-op after the first request
    if request.endpoint in PUBLIC_ENDPOINTS or current_user.is_authenticated:
        return None
    response = login_manager.unauthorized()
    if _is_htmx():
        # Session ended during an in-page navigation: make the browser do a
        # full redirect to the login page instead of swapping it into the page
        target = response.headers.get('Location', url_for('auth.login'))
        response = make_response('', 204)
        response.headers['HX-Redirect'] = target
    return response


# Both registered after require_login, so a logged-out POST is sent to
# the login page first. Route limits are checked when the view runs,
# after the CSRF check, so only requests with a valid token count (the
# others never reach the password check).
limiter.init_app(app)
CSRFProtect(app)


# ─────────────────────────────────────────
# SECURITY HEADERS
# The pages use inline <script> blocks, inline event handlers
# (onclick=...) and inline styles, so the CSP allows 'unsafe-inline'
# for scripts and styles. Everything else is same-origin, apart from
# Google Fonts.
# ─────────────────────────────────────────
CSP = "; ".join([
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "media-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
])


@app.after_request
def security_headers(response):
    response.headers["X-Content-Type-Options"]  = "nosniff"
    response.headers["X-Frame-Options"]         = "DENY"
    response.headers["Referrer-Policy"]         = "strict-origin-when-cross-origin"
    response.headers.setdefault("Content-Security-Policy", CSP)
    return response


# ─────────────────────────────────────────
# ERROR PAGES
# Friendly pages, never a stack trace
# ─────────────────────────────────────────
ERROR_PAGES = {
    400: ("Something went wrong with that request",
          "Please go back, refresh the page and try again."),
    404: ("Page not found",
          "That page or book doesn't exist, or it isn't in your library."),
    413: ("That file is too large",
          "Uploads can be at most 100 MB."),
    429: ("Slow down a little",
          "Too many attempts in a short time. Please wait a minute and try again."),
    500: ("Something went wrong on our side",
          "The problem has been logged. Please try again in a moment."),
}


def _error_page(code: int):
    title, message = ERROR_PAGES[code]
    return render_template('error.html', code=code, title=title, message=message), code


@app.errorhandler(400)
def bad_request(_error):
    return _error_page(400)


@app.errorhandler(404)
def not_found(_error):
    return _error_page(404)


@app.errorhandler(413)
def too_large(_error):
    # Uploads go back to the library with a message; anything else
    # gets the error page
    if request.endpoint == 'upload':
        flash("That file is too large. PDFs can be at most 100 MB.", "error")
        return redirect(url_for('index'))
    return _error_page(413)


@app.errorhandler(429)
def too_many_requests(_error):
    if request.endpoint == 'upload':
        flash("Too many uploads in a short time. Please try again later.", "error")
        return redirect(url_for('index'))
    return _error_page(429)


@app.errorhandler(500)
def server_error(_error):
    # The real exception is logged by Flask (and gunicorn's error log)
    try:
        db.session.rollback()
    except Exception:
        pass
    try:
        return _error_page(500)
    except Exception:
        # Rendering loads the user (Flask-Login), which fails while the
        # database is down, so fall back to a page that needs nothing
        title, message = ERROR_PAGES[500]
        return f"<!DOCTYPE html><title>WAudible</title><h1>{title}</h1><p>{message}</p>", 500


def _get_book(book_id: int) -> Book:
    """The current user's book, or 404 (never 403) if it isn't theirs."""
    book = Book.query.filter_by(id=book_id, user_id=current_user.id).first()
    if book is None:
        abort(404)
    return book


def _voice(source) -> str:
    """The voice ends up in file paths, so only known voices pass."""
    voice = source.get('voice', 'af_heart')
    if voice not in VOICES:
        abort(400)
    return voice


def _speed(source) -> float:
    """Playback speed saved in progress (audio itself is always 1.0)."""
    try:
        speed = float(source.get('speed', 1.0))
    except (TypeError, ValueError):
        abort(400)
    if speed not in SPEEDS:
        abort(400)
    return speed


def _cover_ext(filename: str) -> str | None:
    ext = filename.rsplit('.', 1)[1].lower() if '.' in filename else ''
    ext = 'jpg' if ext == 'jpeg' else ext
    return ext if ext in COVER_TYPES else None


# ─────────────────────────────────────────
# PAGES: full page, or just the content for htmx
# The player, mini player and sheets live in base.html and stay
# put; in-app navigation (htmx) swaps only #app-content.
# ─────────────────────────────────────────
def _is_htmx() -> bool:
    return request.headers.get('HX-Request') == 'true'


def render_page(template: str, **context):
    """Full page for normal loads, the content fragment for htmx swaps.
    History restores (back button with an empty htmx cache) get the
    full page, and htmx takes #app-content out of it."""
    fragment = _is_htmx() and not request.headers.get('HX-History-Restore-Request')
    response = make_response(render_template(
        template, layout='fragment.html' if fragment else 'base.html', **context))
    response.vary.add('HX-Request')
    if fragment and request.method == 'GET':
        # After a redirect (upload, delete) the address bar shows where we landed
        response.headers['HX-Push-Url'] = request.full_path.rstrip('?')
    return response


@app.context_processor
def player_constants():
    return {"voices": VOICES, "speeds": SPEEDS}


def _library_context():
    books = (Book.query.filter_by(user_id=current_user.id)
             .order_by(Book.created_at).all())

    def card(book):
        page = book.progress.current_page if book.progress else 0
        return {
            "id"          : book.id,
            "title"       : book.title,
            "author"      : book.author,
            "genre"       : book.genre,
            "pages"       : book.pages,
            "current_page": page,
            # How far through the book (a page counts once it is reached)
            "percent"     : round(100 * (page + 1) / book.pages) if book.pages and page else 0,
            "processed"   : book.pages_done,
            "running"     : book.status == "processing",
            "cover"       : bool(book.cover),
        }

    # Group books by genre shelf
    shelves = {}
    for book in books:
        shelves.setdefault(book.genre, []).append(card(book))

    # Continue listening: books opened since they were uploaded (opening
    # the reader saves progress), most recently played first
    played = [b for b in books if b.progress and b.progress.updated_at
              and (b.progress.updated_at - b.created_at).total_seconds() > 2]
    played.sort(key=lambda b: b.progress.updated_at, reverse=True)

    return {"shelves": shelves,
            "continue_listening": [card(b) for b in played[:6]],
            "preset_genres": PRESET_GENRES}


# ─────────────────────────────────────────
# HOME: continue listening and the shelves
# LIBRARY: the shelves on their own
# ─────────────────────────────────────────
@app.route('/')
def index():
    return render_page('index.html', view='home', **_library_context())


@app.route('/library')
def library():
    return render_page('index.html', view='library', **_library_context())


# ─────────────────────────────────────────
# UPLOAD PDF + OPTIONAL COVER
# ─────────────────────────────────────────
@app.route('/upload', methods=['POST'])
@limiter.limit(UPLOAD_LIMIT)
def upload():
    file = request.files.get('pdf')
    if not file or not file.filename:
        flash("Choose a PDF file to upload.", "error")
        return redirect(url_for('index'))

    if Book.query.filter_by(user_id=current_user.id).count() >= MAX_BOOKS:
        flash(f"You can have at most {MAX_BOOKS} books. Delete one to upload another.", "error")
        return redirect(url_for('index'))

    # Check the content, not just the .pdf extension
    if file.stream.read(4) != b"%PDF":
        flash("That file is not a PDF.", "error")
        return redirect(url_for('index'))
    file.stream.seek(0)

    # Cover is optional, but must be a real jpg, png or webp under 5 MB
    cover_file = request.files.get('cover')
    cover_ext  = None
    if cover_file and cover_file.filename:
        cover_ext = _cover_ext(cover_file.filename)
        head      = cover_file.stream.read(12)
        cover_file.stream.seek(0, os.SEEK_END)
        size      = cover_file.stream.tell()
        cover_file.stream.seek(0)
        if not cover_ext or not COVER_TYPES[cover_ext](head):
            flash("Cover images must be JPG, PNG or WebP.", "error")
            return redirect(url_for('index'))
        if size > MAX_COVER_BYTES:
            flash("Cover images can be at most 5 MB.", "error")
            return redirect(url_for('index'))

    # Save under a random storage_key, never the uploaded filename
    storage_key = new_storage_key()
    file.save(pdf_path(storage_key))
    try:
        info = get_book_info(pdf_path(storage_key))
    except Exception:
        remove_book_files(storage_key, None)
        flash("That PDF could not be read.", "error")
        return redirect(url_for('index'))

    cover = None
    if cover_ext:
        cover = f"{storage_key}.{cover_ext}"
        cover_file.save(cover_path(cover))

    # Genre: use custom if provided, else preset
    genre = request.form.get('custom_genre', '').strip()
    if not genre:
        genre = request.form.get('genre', 'Other')

    original_name = file.filename[:255]
    title = info["title"]
    if title == "Unknown Title":
        title = original_name.rsplit('.', 1)[0] or original_name

    book = Book(user_id=current_user.id,
                storage_key=storage_key,
                original_name=original_name,
                title=title[:255],
                author=info["author"][:255],
                pages=info["pages"],
                genre=genre[:100] or "Other",
                cover=cover,
                status="processing" if info["pages"] else "ready",
                pages_done=0)
    book.progress = Progress()
    db.session.add(book)
    db.session.commit()

    # Background audio processing, one book at a time
    if book.status == "processing":
        enqueue(book.id)

    return redirect(url_for('index'))


# ─────────────────────────────────────────
# SERVE COVER IMAGE
# ─────────────────────────────────────────
@app.route('/cover/<int:book_id>')
def cover(book_id):
    book = _get_book(book_id)
    has_cover = bool(book.cover) and os.path.exists(cover_path(book.cover))

    # ?size=96|192|512: square PNG for the lock screen (Media Session),
    # with a generated fallback when the book has no cover
    size = request.args.get('size')
    if size is not None:
        if not size.isdigit() or int(size) not in ARTWORK_SIZES:
            abort(400)
        size = int(size)
        try:
            png = cover_artwork(cover_path(book.cover), size) if has_cover else None
        except Exception:
            png = None   # unreadable cover: fall back to initials
        png = png or fallback_artwork(book.title, size)
        response = app.response_class(png, mimetype='image/png')
        response.headers['Cache-Control'] = 'private, max-age=86400'
        return response

    if not has_cover:
        abort(404)
    return send_file(cover_path(book.cover))


# ─────────────────────────────────────────
# READER PAGE
# ─────────────────────────────────────────
@app.route('/read/<int:book_id>')
def read(book_id):
    """The player is a sheet over the library: show the home page with
    this book opened in the player."""
    book = _get_book(book_id)
    return render_page('index.html', view='home', open_book=book.id, **_library_context())


@app.route('/player/<int:book_id>')
def player_data(book_id):
    """What the persistent player needs to load a book (read only)."""
    book     = _get_book(book_id)
    progress = book.progress
    return jsonify({
        "id"      : book.id,
        "title"   : book.title,
        "author"  : book.author or "",
        "genre"   : book.genre,
        "pages"   : book.pages,
        "cover"   : f"/cover/{book.id}" if book.cover else f"/cover/{book.id}?size=512",
        "page"    : progress.current_page if progress else 0,
        "speed"   : progress.speed if progress else 1.0,
        "voice"   : progress.voice if progress else "af_heart",
        "running" : book.status == "processing",
        # When the progress was saved (ms), so a downloaded copy's newer
        # offline position can win
        "updated" : _ms(progress.updated_at) if progress and progress.updated_at else 0,
    })


def _ms(when: datetime) -> int:
    return int(when.timestamp() * 1000)


# ─────────────────────────────────────────
# SERVE AUDIO FOR A PAGE
# ─────────────────────────────────────────
@app.route('/audio/<int:book_id>/<int:page>')
def get_audio(book_id, page):
    book  = _get_book(book_id)
    voice = _voice(request.args)
    if page >= book.pages:
        return jsonify({"error": "Page out of range"}), 400

    audio_path = get_audio_path(book.storage_key, page, voice)
    if not audio_path:
        # Not generated yet: make this one page now
        text       = extract_page(pdf_path(book.storage_key), page)
        audio_path = text_to_audio(text, book.storage_key,
                                   page=page, voice=voice, book_id=book.id)
        if not audio_path:
            abort(404)

    return send_file(audio_path, mimetype='audio/mpeg')


# ─────────────────────────────────────────
# PROCESSING STATUS
# Same JSON shape the progress bars poll
# ─────────────────────────────────────────
@app.route('/status/<int:book_id>')
def processing_status(book_id):
    book = _get_book(book_id)
    return jsonify({
        "total"  : book.pages,
        "done"   : book.pages_done,
        "running": book.status == "processing",
    })


# ─────────────────────────────────────────
# TABLE OF CONTENTS
# ─────────────────────────────────────────
@app.route('/toc/<int:book_id>')
def toc(book_id):
    book = _get_book(book_id)
    return jsonify(extract_toc(pdf_path(book.storage_key)))


# ─────────────────────────────────────────
# PAGE READINESS: which pages have audio
# ─────────────────────────────────────────
@app.route('/readiness/<int:book_id>')
def readiness(book_id):
    """Return list of page numbers that have audio ready."""
    book  = _get_book(book_id)
    voice = _voice(request.args)
    ready = [
        i for i in range(book.pages)
        if get_audio_path(book.storage_key, i, voice)
    ]
    return jsonify({"ready": ready, "total": book.pages})


# ─────────────────────────────────────────
# PAGE TEXT PREVIEW
# ─────────────────────────────────────────
@app.route('/page_text/<int:book_id>/<int:page>')
def page_text(book_id, page):
    book = _get_book(book_id)
    if page >= book.pages:
        return jsonify({"text": "Page out of range"})
    return jsonify({"text": extract_page(pdf_path(book.storage_key), page)})


# ─────────────────────────────────────────
# SAVE READING PROGRESS
# ─────────────────────────────────────────
@app.route('/save_progress', methods=['POST'])
def save():
    data = request.get_json(silent=True) or {}
    try:
        book_id = int(data['book_id'])
        page    = int(data['page'])
    except (KeyError, TypeError, ValueError):
        abort(400)
    book  = _get_book(book_id)
    speed = _speed(data)
    voice = _voice(data)
    if not 0 <= page < max(book.pages, 1):
        abort(400)

    # Positions saved offline are sent later with the time they were
    # made ("at", ms). The latest position wins: an older one is ignored.
    now  = datetime.now(timezone.utc)
    when = now
    if data.get('at') is not None:
        try:
            when = min(datetime.fromtimestamp(float(data['at']) / 1000, timezone.utc), now)
        except (TypeError, ValueError, OverflowError, OSError):
            abort(400)

    if book.progress is None:
        book.progress = Progress()
    elif when < now and book.progress.updated_at and book.progress.updated_at > when:
        return jsonify({"status": "stale"})
    book.progress.current_page = page
    book.progress.speed        = speed
    book.progress.voice        = voice
    # Always counts as listened to (Continue listening), even when the
    # page, speed and voice are the same as before
    book.progress.updated_at   = when
    db.session.commit()
    return jsonify({"status": "saved"})


# ─────────────────────────────────────────
# DELETE BOOK
# ─────────────────────────────────────────
@app.route('/delete/<int:book_id>', methods=['POST'])
def delete_book(book_id):
    book        = _get_book(book_id)
    storage_key = book.storage_key
    cover       = book.cover

    # Stop the worker for this book first, then remove rows and files
    delete_book_audio(storage_key)
    db.session.delete(book)   # progress row goes with it
    db.session.commit()
    remove_book_files(storage_key, cover)

    return redirect(url_for('index'))


# ─────────────────────────────────────────
# OFFLINE (PWA)
# The web app manifest, the service worker and the offline page are
# public and hold no user data. Everything a download needs is behind
# login and the owner check, and is never cached by the service worker
# (it only keeps what the page itself saved).
# ─────────────────────────────────────────
APP_DIR = os.path.dirname(os.path.abspath(__file__))

# Precached by the service worker (cache first)
SHELL_FILES = ["css/style.css", "js/htmx.min.js", "js/sheets.js", "js/offline.js",
               "js/player.js", "js/app.js", "icons/icon-192.png", "icons/icon-512.png",
               "icons/maskable-512.png", "icons/apple-touch-icon.png"]
SHELL_URLS  = ["/offline", "/manifest.webmanifest"] + [f"/static/{f}" for f in SHELL_FILES]
FONT_CSS    = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"


def _shell_version() -> str:
    """Changes whenever the worker, a shell file or a template changes, so
    the browser installs the new worker and drops the old caches."""
    h = hashlib.sha256()
    paths = [os.path.join(APP_DIR, "sw.js")] + [os.path.join(app.static_folder, f) for f in SHELL_FILES]
    tpl = os.path.join(APP_DIR, "templates")
    paths += sorted(os.path.join(tpl, f) for f in os.listdir(tpl))
    for path in paths:
        with open(path, "rb") as f:
            h.update(f.read())
    return h.hexdigest()[:12]


SHELL_VERSION = _shell_version()


def _always_fresh(response):
    """For the service worker, the manifest and the offline page: the
    browser must check with the server every time, so a new version
    applies straight away. Cloudflare caches .js files at the edge by
    default and then replaces Cache-Control with its own Browser Cache
    TTL (4 hours), so it is also told not to keep a copy, which makes it
    pass this header through unchanged."""
    response.headers["Cache-Control"] = "no-cache, max-age=0"
    response.headers["CDN-Cache-Control"] = "no-store"
    response.headers["Cloudflare-CDN-Cache-Control"] = "no-store"
    return response


@app.route('/manifest.webmanifest')
def web_manifest():
    icons = "/static/icons/"
    response = make_response(json.dumps({
        "name"            : "WAudible",
        "short_name"      : "WAudible",
        "description"     : "Your PDF books, read aloud.",
        "id"              : "/",
        "start_url"       : "/",
        "scope"           : "/",
        "display"         : "standalone",
        "background_color": "#121212",
        "theme_color"     : "#E95420",
        "icons": [
            {"src": icons + "icon-192.png",     "sizes": "192x192", "type": "image/png", "purpose": "any"},
            {"src": icons + "icon-512.png",     "sizes": "512x512", "type": "image/png", "purpose": "any"},
            {"src": icons + "maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
        ],
    }))
    response.mimetype = "application/manifest+json"
    return _always_fresh(response)


@app.route('/sw.js')
def service_worker():
    with open(os.path.join(APP_DIR, "sw.js"), encoding="utf-8") as f:
        source = f.read()
    source = (source.replace("__VERSION__", SHELL_VERSION)
                    .replace("__SHELL_URLS__", json.dumps(SHELL_URLS))
                    .replace("__FONT_CSS__", json.dumps(FONT_CSS)))
    response = make_response(source)
    response.mimetype = "text/javascript"
    # Checked on every visit, so a new version applies straight away
    _always_fresh(response)
    # The worker's own policy: same origin, plus the Google Fonts files
    # the pages already use (cached so the app looks the same offline)
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com")
    return response


@app.route('/offline')
def offline_page():
    """The app shell with no user data and no CSRF token: the service
    worker precaches it and shows it when the network is gone. The list
    of downloaded books is drawn in the browser from IndexedDB."""
    response = make_response(render_template('offline.html', layout='base.html', offline_shell=True))
    return _always_fresh(response)


def _no_store(response):
    response.headers["Cache-Control"] = "no-store"
    return response


@app.route('/downloads')
def downloads():
    """Downloaded books on this device (drawn in the browser)."""
    return render_page('downloads.html', view='downloads')


@app.route('/offline/books')
def offline_books():
    """The user's book ids, so the browser can drop copies of deleted books."""
    ids = [b.id for b in Book.query.with_entities(Book.id).filter_by(user_id=current_user.id)]
    return _no_store(jsonify({"user": current_user.id, "books": ids}))


@app.route('/offline/csrf')
def offline_csrf():
    """A fresh token for sending progress saved while offline."""
    return _no_store(jsonify({"token": generate_csrf()}))


def _artwork_files(book: Book) -> list[dict]:
    """The cover the player shows and the three lock-screen sizes."""
    files = []
    has_cover = bool(book.cover) and os.path.exists(cover_path(book.cover))
    if has_cover:
        files.append({"url": f"/cover/{book.id}", "bytes": os.path.getsize(cover_path(book.cover)),
                      "kind": "cover"})
    for size in ARTWORK_SIZES:
        try:
            png = cover_artwork(cover_path(book.cover), size) if has_cover else None
        except Exception:
            png = None
        png = png or fallback_artwork(book.title, size)
        files.append({"url": f"/cover/{book.id}?size={size}", "bytes": len(png), "kind": "artwork"})
    return files


def _audio_files(book: Book, voice: str) -> list[dict]:
    files = []
    for page in range(book.pages):
        path = get_audio_path(book.storage_key, page, voice)
        # Missing for this voice: made on demand when downloaded
        files.append({"url": f"/audio/{book.id}/{page}?voice={voice}",
                      "bytes": os.path.getsize(path) if path else None, "page": page, "kind": "audio"})
    return files


def _offline_voice(book: Book) -> str:
    voice = book.progress.voice if book.progress else "af_heart"
    return voice if voice in VOICES else "af_heart"


TEXT_BYTES_GUESS = 2000     # per page, for the estimate only


@app.route('/offline/size/<int:book_id>')
def offline_size(book_id):
    """Quick estimate for the confirm step and the download suggestion
    (audio sizes are exact, covers and text are guessed)."""
    book  = _get_book(book_id)
    voice = _offline_voice(book)
    audio = _audio_files(book, voice)
    known = [f["bytes"] for f in audio if f["bytes"] is not None]
    average = sum(known) / len(known) if known else 240_000
    total = sum(known) + average * (len(audio) - len(known)) + book.pages * TEXT_BYTES_GUESS + 150_000
    if book.cover and os.path.exists(cover_path(book.cover)):
        total += os.path.getsize(cover_path(book.cover))
    return _no_store(jsonify({"bytes": int(total), "voice": voice, "pages": book.pages,
                              "ready": book.status == "ready"}))


@app.route('/offline/manifest/<int:book_id>')
def offline_manifest(book_id):
    """Everything needed to play one finished book with no network: details,
    contents, page text, and the URL and size of every file, for the
    voice the user listens with."""
    book = _get_book(book_id)
    if book.status != "ready":
        return _no_store(jsonify({"error": "This book is still being prepared."})), 409
    voice = _offline_voice(book)
    progress = book.progress
    texts = extract_pages(pdf_path(book.storage_key))
    files = _artwork_files(book) + _audio_files(book, voice)
    return _no_store(jsonify({
        "id"    : book.id,
        "title" : book.title,
        "author": book.author or "",
        "genre" : book.genre,
        "pages" : book.pages,
        "voice" : voice,
        "cover" : f"/cover/{book.id}" if book.cover else f"/cover/{book.id}?size=512",
        "toc"   : extract_toc(pdf_path(book.storage_key)),
        "texts" : texts,
        "files" : files,
        # Where the listener is now, the starting point on this device
        "progress": {"page": progress.current_page, "speed": progress.speed,
                     "at": _ms(progress.updated_at) if progress.updated_at else 0} if progress else None,
        "bytes" : sum(f["bytes"] or 0 for f in files) + sum(len(t.encode()) for t in texts),
    }))


if __name__ == '__main__':
    app.run(debug=DEBUG, port=5000)
