import os
import secrets
import shutil

# ─────────────────────────────────────────
# PATHS
# Every file for a book lives under its random
# storage_key. Uploaded filenames are never paths.
# ─────────────────────────────────────────
DATA_DIR   = os.path.join(os.path.dirname(__file__), '..', 'data')
BOOKS_DIR  = os.path.join(DATA_DIR, 'books')
COVERS_DIR = os.path.join(DATA_DIR, 'covers')
AUDIO_DIR  = os.path.join(DATA_DIR, 'audio')
for _d in (BOOKS_DIR, COVERS_DIR, AUDIO_DIR):
    os.makedirs(_d, exist_ok=True)


def new_storage_key() -> str:
    return secrets.token_hex(16)


def pdf_path(storage_key: str) -> str:
    return os.path.join(BOOKS_DIR, f"{storage_key}.pdf")


def cover_path(cover: str) -> str:
    """cover is the stored cover filename, <storage_key>.<ext>"""
    return os.path.join(COVERS_DIR, cover)


def audio_dir(storage_key: str) -> str:
    return os.path.join(AUDIO_DIR, storage_key)


def remove_book_files(storage_key: str, cover: str | None):
    """Delete the PDF, the cover and the whole audio folder for a book."""
    for path in (pdf_path(storage_key), cover_path(cover) if cover else None):
        if path and os.path.exists(path):
            os.remove(path)
    shutil.rmtree(audio_dir(storage_key), ignore_errors=True)
