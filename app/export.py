import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import unicodedata
from app.artwork import fallback_artwork
from app.storage import EXPORTS_DIR, cover_path
from app.tts_engine import get_audio_path

log = logging.getLogger(__name__)

# ─────────────────────────────────────────
# SAVE TO DEVICE
# One proper MP3 for a chapter, a page range or the whole book, for the
# phone's Downloads folder (any file manager, music player or VLC). The
# page MP3s that already exist are joined by ffmpeg with stream copy (no
# re-encode, so it takes a moment even for a whole book), with ID3 tags,
# the cover as artwork and a chapter marker per page (or per chapter for
# the whole book). Every ffmpeg call is an argument list, never a shell.
#
# A build happens in its own folder under EXPORTS_DIR. The finished file
# is opened and the folder deleted before the first byte is sent, so a
# cancelled download, a crash or a closed connection leaves nothing
# behind. At most BUILD_SLOTS builds run at once; another request waits
# up to WAIT_SECONDS for a slot, then gets "busy".
# ─────────────────────────────────────────
BUILD_SLOTS  = 1
WAIT_SECONDS = 30
_slots = threading.BoundedSemaphore(BUILD_SLOTS)
ARTWORK_SIZE = 600


class ExportError(Exception):
    """A request that can't be met, with the message the listener sees."""

    def __init__(self, message: str, status: int = 409):
        super().__init__(message)
        self.message, self.status = message, status


class Busy(ExportError):
    def __init__(self):
        super().__init__("Another file is being prepared right now. Please try again in a moment.", 503)


def clear_leftovers():
    """Builds from before a crash or restart (called at startup)."""
    for name in os.listdir(EXPORTS_DIR):
        shutil.rmtree(os.path.join(EXPORTS_DIR, name), ignore_errors=True)


# ── CHAPTERS (the same rules as chaptersOf in static/js/offline.js) ──
def chapters(toc: list[dict], pages: int) -> list[dict]:
    """
    Chapters as page ranges: each contents entry runs to the next one.
    Pages before the first entry are "Beginning"; a PDF without real
    chapter titles gets blocks of 10 pages.
    """
    entries = sorted((c for c in toc or [] if 0 <= c["page"] < pages), key=lambda c: c["page"])
    entries = [c for i, c in enumerate(entries) if i == 0 or c["page"] != entries[i - 1]["page"]]
    generic = not entries or all(re.fullmatch(r"Page \d+", c["title"]) for c in entries)
    if generic:
        entries = [{"page": i * 10, "title": ""} for i in range((pages + 9) // 10)]
    if entries and entries[0]["page"] > 0:
        entries.insert(0, {"page": 0, "title": "Beginning"})
    out = []
    for i, c in enumerate(entries):
        end = (entries[i + 1]["page"] if i + 1 < len(entries) else pages) - 1
        title = c["title"] if not generic and c["title"] else f"Pages {c['page'] + 1} to {end + 1}"
        out.append({"index": i, "start": c["page"], "end": end, "title": title})
    return out


# ── NAMES ──
def safe_name(text: str, limit: int = 120) -> str:
    """A filename part every phone and computer accepts: no slashes,
    reserved characters or control characters, no leading or trailing dots
    or spaces, not too long. Letters with accents stay."""
    text = unicodedata.normalize("NFC", text or "")
    text = "".join(" " if unicodedata.category(ch)[0] == "C" else ch for ch in text)
    text = re.sub(r'[\\/:*?"<>|]+', " ", text)
    text = re.sub(r"\s+", " ", text).strip(" .")
    if len(text) > limit:
        text = text[:limit].rstrip(" .")
    return text


def file_name(book_title: str, part: str | None, track: int | None = None, tracks: int = 0) -> str:
    """"Grit - 03 Chapter title.mp3", "Grit - Pages 12 to 20.mp3" or "Grit.mp3"."""
    title = safe_name(book_title, 80) or "Book"
    if part is None:
        return f"{title}.mp3"
    number = f"{track:0{max(2, len(str(tracks)))}d} " if track is not None else ""
    return f"{title} - {number}{safe_name(part, 100) or 'Part'}.mp3"


# ── WHAT TO SAVE ──
def plan(book, toc: list[dict], voice: str, *, chapter: int | None = None,
         first: int | None = None, last: int | None = None, whole: bool = False) -> dict:
    """
    The pages, name and tags for one file. Raises ExportError (400) for a
    request that makes no sense, or (409) when a page has no audio yet in
    this voice: a file with gaps would be confusing, so it is refused.
    """
    chs = chapters(toc, book.pages)
    if chapter is not None:
        if not 0 <= chapter < len(chs):
            raise ExportError("That chapter doesn't exist.", 400)
        ch = chs[chapter]
        pages = list(range(ch["start"], ch["end"] + 1))
        what = f'"{ch["title"]}"'
        info = {"title": ch["title"], "track": chapter + 1, "tracks": len(chs),
                "name": file_name(book.title, ch["title"], chapter + 1, len(chs)),
                "markers": [(f"Page {p + 1}", [p]) for p in pages]}
    elif whole:
        pages = list(range(book.pages))
        what = "The book"
        info = {"title": book.title, "track": None, "tracks": 0, "name": file_name(book.title, None),
                "markers": [(c["title"], list(range(c["start"], c["end"] + 1))) for c in chs]}
    else:
        if first is None or last is None or not 0 <= first <= last < book.pages:
            raise ExportError(f"Choose pages from 1 to {book.pages}.", 400)
        pages = list(range(first, last + 1))
        part = f"Pages {first + 1} to {last + 1}" if first != last else f"Page {first + 1}"
        what = part
        info = {"title": part, "track": None, "tracks": 0, "name": file_name(book.title, part),
                "markers": [(f"Page {p + 1}", [p]) for p in pages]}

    files = [get_audio_path(book.storage_key, p, voice) for p in pages]
    missing = [p for p, f in zip(pages, files) if not f]
    if missing:
        have = len(pages) - len(missing)
        raise ExportError(f"{what} isn't ready to save yet: {have} of {len(pages)} pages have audio in this voice. "
                          "Listen to it in this voice (or wait for the book to finish), then try again.")
    info.update(pages=pages, files=files, bytes=sum(os.path.getsize(f) for f in files))
    return info


# ── BUILDING ──
def _ffmpeg(args: list[str], timeout: int = 600):
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", *args],
                   capture_output=True, check=True, timeout=timeout)


def duration(path: str) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", path],
                         capture_output=True, check=True, text=True, timeout=30).stdout
    return float(json.loads(out)["format"]["duration"])


def _concat_line(path: str) -> str:
    return "file '" + path.replace("'", "'\\''") + "'\n"


def _meta(value: str) -> str:
    """Escape a value for ffmpeg's metadata file format."""
    return re.sub(r"([=;#\\\n])", r"\\\1", value)


def _chapter_file(markers, durations: dict) -> str:
    lines, at = [";FFMETADATA1\n"], 0
    for title, pages in markers:
        length = sum(int(round(durations[p] * 1000)) for p in pages)
        lines.append(f"[CHAPTER]\nTIMEBASE=1/1000\nSTART={at}\nEND={at + length}\ntitle={_meta(title)}\n")
        at += length
    return "".join(lines)


def build(book, info: dict) -> tuple:
    """
    Make the MP3 and return (open file, size). The build folder is gone
    by the time this returns; the open file is all that is left, and it
    disappears when closed. Raises Busy when no slot frees up in time.
    """
    if not _slots.acquire(timeout=WAIT_SECONDS):
        raise Busy()
    work = tempfile.mkdtemp(prefix="build-", dir=EXPORTS_DIR)
    try:
        listing = os.path.join(work, "pages.txt")
        with open(listing, "w", encoding="utf-8") as f:
            f.writelines(_concat_line(p) for p in info["files"])

        # Cover (or the initials artwork for a book without one)
        cover = cover_path(book.cover) if book.cover else None
        if not cover or not os.path.exists(cover):
            cover = os.path.join(work, "cover.png")
            with open(cover, "wb") as f:
                f.write(fallback_artwork(book.title, ARTWORK_SIZE))

        # Chapter markers need each page's length; one marker only adds noise
        chapters_file = None
        if len(info["markers"]) > 1:
            durations = {p: duration(f) for p, f in zip(info["pages"], info["files"])}
            chapters_file = os.path.join(work, "chapters.txt")
            with open(chapters_file, "w", encoding="utf-8") as f:
                f.write(_chapter_file(info["markers"], durations))

        # Square JPEG artwork, letterboxed like the lock-screen artwork
        size = ARTWORK_SIZE
        art = os.path.join(work, "cover.jpg")
        _ffmpeg(["-i", cover, "-frames:v", "1", "-q:v", "3",
                 "-vf", f"scale={size}:{size}:force_original_aspect_ratio=decrease,"
                        f"pad={size}:{size}:(ow-iw)/2:(oh-ih)/2:color=0x111111", art], timeout=30)

        tags = {"title": info["title"], "album": book.title, "artist": book.author or "",
                "album_artist": book.author or "", "genre": "Audiobook"}
        if info["track"]:
            tags["track"] = f"{info['track']}/{info['tracks']}"
        # Everything copied as it is: the page frames, then the artwork
        args = ["-f", "concat", "-safe", "0", "-i", listing, "-i", art]
        if chapters_file:
            args += ["-f", "ffmetadata", "-i", chapters_file]
        args += ["-map", "0:a", "-map", "1:v",
                 "-map_metadata", "2" if chapters_file else "-1",
                 "-map_chapters", "2" if chapters_file else "-1",
                 "-c", "copy",
                 "-disposition:v:0", "attached_pic",
                 "-metadata:s:v", "title=Album cover", "-metadata:s:v", "comment=Cover (front)",
                 "-id3v2_version", "3"]
        for key, value in tags.items():
            args += ["-metadata", f"{key}={value}"]
        out = os.path.join(work, "out.mp3")
        args += ["-f", "mp3", out]
        _ffmpeg(args)
        handle = open(out, "rb")
        return handle, os.fstat(handle.fileno()).st_size
    except subprocess.CalledProcessError as e:
        log.error("Save to device failed for book %s: %s", book.id,
                  (e.stderr or b"").decode(errors="replace").strip().splitlines()[-1:] or "ffmpeg error")
        raise ExportError("The file couldn't be made. Please try again.", 500)
    finally:
        shutil.rmtree(work, ignore_errors=True)
        _slots.release()
