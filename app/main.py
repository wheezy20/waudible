import os
from datetime import datetime, timezone
from flask import (Flask, render_template, request, abort, flash,
                   send_file, redirect, url_for, jsonify, make_response)
from flask_login import current_user
from flask_wtf.csrf import CSRFProtect
from werkzeug.middleware.proxy_fix import ProxyFix
from app.pdf_reader import extract_page, get_book_info, extract_toc
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

app = Flask(__name__)


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

PUBLIC_ENDPOINTS = {"auth.login", "auth.register", "static"}


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
    response.headers["Content-Security-Policy"] = CSP
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
    return _error_page(500)


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
    })


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
                                   page=page, voice=voice)
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

    if book.progress is None:
        book.progress = Progress()
    book.progress.current_page = page
    book.progress.speed        = speed
    book.progress.voice        = voice
    # Always counts as listened to (Continue listening), even when the
    # page, speed and voice are the same as before
    book.progress.updated_at   = datetime.now(timezone.utc)
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


if __name__ == '__main__':
    app.run(debug=DEBUG, port=5000)
