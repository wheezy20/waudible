import os
from flask import (Flask, render_template, request, abort, flash,
                   send_file, redirect, url_for, jsonify)
from flask_login import current_user
from flask_wtf.csrf import CSRFProtect
from app.pdf_reader import extract_page, get_book_info, extract_toc
from app.tts_engine import (text_to_audio, list_voices, get_audio_path,
                            delete_book_audio, VOICES, SPEEDS)
from app.storage import (new_storage_key, pdf_path, cover_path,
                         remove_book_files)
from app.worker import enqueue, start_worker
from app.config import database_url
from app.models import db, Book, Progress
from app.auth import auth, login_manager

app = Flask(__name__)

# ─────────────────────────────────────────
# CONFIG (secrets come from .env)
# ─────────────────────────────────────────
SECRET_KEY = os.environ.get("SECRET_KEY")
if not SECRET_KEY:
    raise RuntimeError("SECRET_KEY is not set in .env (see .env.example)")
app.config["SECRET_KEY"] = SECRET_KEY

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
    return login_manager.unauthorized()


# Registered after require_login, so a logged-out POST is sent to the
# login page instead of failing the CSRF check
CSRFProtect(app)


@app.errorhandler(413)
def too_large(_error):
    flash("That file is too large. PDFs can be at most 100 MB.", "error")
    return redirect(url_for('index'))


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
# HOME PAGE: the user's genre shelves
# ─────────────────────────────────────────
@app.route('/')
def index():
    books = (Book.query.filter_by(user_id=current_user.id)
             .order_by(Book.created_at).all())

    # Group books by genre shelf
    shelves = {}
    for book in books:
        shelves.setdefault(book.genre, []).append({
            "id"          : book.id,
            "title"       : book.title,
            "author"      : book.author,
            "pages"       : book.pages,
            "current_page": book.progress.current_page if book.progress else 0,
            "processed"   : book.pages_done,
            "running"     : book.status == "processing",
            "cover"       : bool(book.cover),
        })

    return render_template('index.html',
                           shelves=shelves,
                           preset_genres=PRESET_GENRES)


# ─────────────────────────────────────────
# UPLOAD PDF + OPTIONAL COVER
# ─────────────────────────────────────────
@app.route('/upload', methods=['POST'])
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
    if not book.cover or not os.path.exists(cover_path(book.cover)):
        abort(404)
    return send_file(cover_path(book.cover))


# ─────────────────────────────────────────
# READER PAGE
# ─────────────────────────────────────────
@app.route('/read/<int:book_id>')
def read(book_id):
    book     = _get_book(book_id)
    progress = book.progress or Progress(current_page=0, speed=1.0, voice="af_heart")
    return render_template('reader.html',
                           book=book,
                           info={"title": book.title, "author": book.author},
                           progress=progress,
                           voices=list_voices(),
                           speeds=SPEEDS,
                           total_pages=book.pages,
                           preset_genres=PRESET_GENRES)


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
    app.run(debug=True, port=5000)
