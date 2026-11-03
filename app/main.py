import os
from flask import (Flask, render_template, request,
                   send_file, redirect, url_for, jsonify)
from app.pdf_reader import extract_pages, get_book_info, get_page_count
from app.tts_engine import (text_to_audio, list_voices,
                             start_background_processing,
                             get_processing_status,
                             get_audio_path, delete_book_audio)
from app.session_manager import (save_progress, load_progress,
                                  save_metadata, delete_session)
from flask_wtf.csrf import CSRFProtect
from app.config import database_url
from app.models import db
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

db.init_app(app)
login_manager.init_app(app)
CSRFProtect(app)
app.register_blueprint(auth)

BOOKS_DIR  = os.path.join(os.path.dirname(__file__), '..', 'data', 'books')
COVERS_DIR = os.path.join(os.path.dirname(__file__), '..', 'data', 'covers')
os.makedirs(BOOKS_DIR,  exist_ok=True)
os.makedirs(COVERS_DIR, exist_ok=True)

ALLOWED_PDF   = {'pdf'}
ALLOWED_IMAGE = {'jpg', 'jpeg', 'png', 'webp'}

PRESET_GENRES = [
    "Self Help", "Academic", "Christian", "Lecture Slides",
    "Fiction", "Biography", "Technology", "Other"
]


def allowed_pdf(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_PDF

def allowed_image(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_IMAGE


# ─────────────────────────────────────────
# HOME PAGE — genre shelves
# ─────────────────────────────────────────
@app.route('/')
def index():
    all_books = []
    for filename in os.listdir(BOOKS_DIR):
        if not filename.endswith('.pdf'):
            continue
        path     = os.path.join(BOOKS_DIR, filename)
        info     = get_book_info(path)
        progress = load_progress(filename)
        status   = get_processing_status(filename)
        all_books.append({
            "filename"    : filename,
            "title"       : info["title"] if info["title"] != "Unknown Title" else filename.replace('.pdf',''),
            "author"      : info["author"],
            "pages"       : info["pages"],
            "current_page": progress["current_page"],
            "processed"   : status["done"],
            "running"     : status["running"],
            "genre"       : progress.get("genre", "Other"),
            "cover"       : progress.get("cover", None),
        })

    # Group books by genre shelf
    shelves = {}
    for book in all_books:
        genre = book["genre"]
        if genre not in shelves:
            shelves[genre] = []
        shelves[genre].append(book)

    return render_template('index.html',
                           shelves=shelves,
                           preset_genres=PRESET_GENRES)


# ─────────────────────────────────────────
# UPLOAD PDF + OPTIONAL COVER
# ─────────────────────────────────────────
@app.route('/upload', methods=['POST'])
def upload():
    if 'pdf' not in request.files:
        return redirect(url_for('index'))

    file = request.files['pdf']
    if file.filename == '' or not allowed_pdf(file.filename):
        return redirect(url_for('index'))

    # Save PDF
    pdf_filename = file.filename
    save_path    = os.path.join(BOOKS_DIR, pdf_filename)
    file.save(save_path)

    # Genre — use custom if provided, else preset
    genre  = request.form.get('custom_genre', '').strip()
    if not genre:
        genre = request.form.get('genre', 'Other')

    # Cover image — save if uploaded
    cover_filename = None
    cover_file     = request.files.get('cover')
    if cover_file and cover_file.filename and allowed_image(cover_file.filename):
        ext            = cover_file.filename.rsplit('.', 1)[1].lower()
        cover_filename = pdf_filename.replace('.pdf', f'_cover.{ext}')
        cover_file.save(os.path.join(COVERS_DIR, cover_filename))

    # Save metadata
    save_metadata(pdf_filename, genre=genre, cover=cover_filename)

    # Start background audio processing
    pages = extract_pages(save_path)
    start_background_processing(pages, pdf_filename, speed=1.0, voice="af_heart")

    return redirect(url_for('index'))


# ─────────────────────────────────────────
# SERVE COVER IMAGE
# ─────────────────────────────────────────
@app.route('/cover/<filename>')
def cover(filename):
    path = os.path.join(COVERS_DIR, filename)
    if not os.path.exists(path):
        return '', 404
    return send_file(path)


# ─────────────────────────────────────────
# READER PAGE
# ─────────────────────────────────────────
@app.route('/read/<filename>')
def read(filename):
    path = os.path.join(BOOKS_DIR, filename)
    if not os.path.exists(path):
        return redirect(url_for('index'))
    info     = get_book_info(path)
    progress = load_progress(filename)
    voices   = list_voices()
    total    = get_page_count(path)
    return render_template('reader.html',
                           filename=filename,
                           info=info,
                           progress=progress,
                           voices=voices,
                           total_pages=total,
                           preset_genres=PRESET_GENRES)


# ─────────────────────────────────────────
# SERVE AUDIO FOR A PAGE
# ─────────────────────────────────────────
@app.route('/audio/<filename>/<int:page>')
def get_audio(filename, page):
    path = os.path.join(BOOKS_DIR, filename)
    if not os.path.exists(path):
        return jsonify({"error": "Book not found"}), 404

    speed      = float(request.args.get('speed', 1.0))
    voice      = request.args.get('voice', 'af_heart')
    audio_path = get_audio_path(filename, page, speed, voice)

    if not audio_path:
        pages = extract_pages(path)
        if page >= len(pages):
            return jsonify({"error": "Page out of range"}), 400
        audio_path = text_to_audio(pages[page], filename,
                                   page=page, speed=speed, voice=voice)

    return send_file(audio_path, mimetype='audio/wav')


# ─────────────────────────────────────────
# PROCESSING STATUS
# ─────────────────────────────────────────
@app.route('/status/<filename>')
def processing_status(filename):
    return jsonify(get_processing_status(filename))


# ─────────────────────────────────────────
# TABLE OF CONTENTS
# ─────────────────────────────────────────
@app.route('/toc/<filename>')
def toc(filename):
    path = os.path.join(BOOKS_DIR, filename)
    if not os.path.exists(path):
        return jsonify([])
    from app.pdf_reader import extract_toc
    chapters = extract_toc(path)
    return jsonify(chapters)


# ─────────────────────────────────────────
# PAGE READINESS — which pages have audio
# ─────────────────────────────────────────
@app.route('/readiness/<filename>')
def readiness(filename):
    """Return list of page numbers that have audio ready."""
    speed = float(request.args.get('speed', 1.0))
    voice = request.args.get('voice', 'af_heart')
    path  = os.path.join(BOOKS_DIR, filename)
    if not os.path.exists(path):
        return jsonify({"ready": []})
    total = get_page_count(path)
    ready = [
        i for i in range(total)
        if get_audio_path(filename, i, speed, voice)
    ]
    return jsonify({"ready": ready, "total": total})


# ─────────────────────────────────────────
# PAGE TEXT PREVIEW
# ─────────────────────────────────────────
@app.route('/page_text/<filename>/<int:page>')
def page_text(filename, page):
    path = os.path.join(BOOKS_DIR, filename)
    if not os.path.exists(path):
        return jsonify({"text": "Book not found"})
    pages = extract_pages(path)
    if page >= len(pages):
        return jsonify({"text": "Page out of range"})
    return jsonify({"text": pages[page]})


# ─────────────────────────────────────────
# SAVE READING PROGRESS
# ─────────────────────────────────────────
@app.route('/save_progress', methods=['POST'])
def save():
    data = request.get_json()
    save_progress(
        book_name=data['filename'],
        page     =data['page'],
        speed    =data.get('speed', 1.0),
        voice    =data.get('voice', 'af_heart'),
    )
    return jsonify({"status": "saved"})


# ─────────────────────────────────────────
# DELETE BOOK
# ─────────────────────────────────────────
@app.route('/delete/<filename>', methods=['POST'])
def delete_book(filename):
    # Delete PDF
    path = os.path.join(BOOKS_DIR, filename)
    if os.path.exists(path):
        os.remove(path)

    # Delete cover image
    progress = load_progress(filename)
    cover    = progress.get("cover")
    if cover:
        cover_path = os.path.join(COVERS_DIR, cover)
        if os.path.exists(cover_path):
            os.remove(cover_path)

    # Delete audio + session
    delete_book_audio(filename)
    delete_session(filename)

    return redirect(url_for('index'))


if __name__ == '__main__':
    app.run(debug=True, port=5000)