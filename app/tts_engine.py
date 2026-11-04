import logging
import os
import re
import shutil
import threading
import numpy as np
from kokoro_onnx import Kokoro
from app.audio_codec import check_ffmpeg, samples_to_mp3
from app.storage import audio_dir

log = logging.getLogger(__name__)

# ─────────────────────────────────────────
# STARTUP CHECKS, THEN LOAD KOKORO ONCE
# ─────────────────────────────────────────
check_ffmpeg()
print("Loading Kokoro voice model...")
kokoro = Kokoro("kokoro-v1.0.onnx", "voices-v1.0.bin")
print("Voice model ready!")

VOICES = [
    "af_heart",
    "af_nova",
    "am_adam",
    "am_echo",
    "bf_emma",
    "bm_george",
]
# Speeds the reader offers. Audio is always generated at 1.0 and the
# browser changes speed with playbackRate, so this is only used to
# validate the speed saved in progress.
SPEEDS = [0.75, 1.0, 1.25, 1.5, 2.0]

# ─────────────────────────────────────────
# DELETE SAFETY
# Audio is generated outside the lock (slow) and
# written inside it. Deleting a book takes the same
# lock, so a page that finishes during a delete is
# dropped instead of recreating the audio folder.
# ─────────────────────────────────────────
_write_lock = threading.Lock()
_cancelled  = set()   # storage_keys of deleted books


# ─────────────────────────────────────────
# PAGES THAT CAN'T BE SPOKEN, AND LONG PAGES
# A page with nothing to say (no letters or digits,
# or Kokoro returns no audio) becomes about 5 seconds
# of silence: long enough that Android keeps its media
# notification. Long pages are spoken in chunks split
# at sentence ends and joined, so one huge page can't
# fail as a whole.
# ─────────────────────────────────────────
SILENCE_SECONDS = 5
SILENCE_RATE    = 24000
CHUNK_CHARS     = 1500    # longer pages are split into chunks of about this size
CHUNK_GAP       = 0.2     # seconds of silence between chunks
NO_TEXT         = "[This page has no readable text]"
_SPEAKABLE      = re.compile(r"[^\W_]")          # any letter or digit, any script
_SENTENCE_END   = re.compile(r"(?<=[.!?;:])\s+|\n\s*\n")


class NoAudio(Exception):
    """Kokoro produced no audio for this text."""


def _audio_path(storage_key: str, page: int, voice: str) -> str:
    """Build a consistent file path for a page's audio file (one per voice)."""
    return os.path.join(audio_dir(storage_key), f"page{page}_v{voice}.mp3")


def is_speakable(text: str | None) -> bool:
    text = (text or "").strip()
    return bool(text) and text != NO_TEXT and _SPEAKABLE.search(text) is not None


def split_text(text: str, limit: int = CHUNK_CHARS) -> list[str]:
    """
    Split text into chunks of at most `limit` characters, at sentence ends
    where possible, then at spaces, and as a last resort mid-word.
    """
    text = text.strip()
    if len(text) <= limit:
        return [text]
    pieces = []
    for sentence in _SENTENCE_END.split(text):
        sentence = sentence.strip()
        while len(sentence) > limit:
            cut = sentence.rfind(" ", 0, limit + 1)
            if cut <= 0:
                cut = limit
            pieces.append(sentence[:cut].strip())
            sentence = sentence[cut:].strip()
        if sentence:
            pieces.append(sentence)
    chunks, current = [], ""
    for piece in pieces:
        if current and len(current) + 1 + len(piece) > limit:
            chunks.append(current)
            current = piece
        else:
            current = f"{current} {piece}" if current else piece
    if current:
        chunks.append(current)
    return chunks


def _speak(text: str, voice: str):
    """Kokoro for one chunk. Raises NoAudio when it yields nothing."""
    try:
        samples, rate = kokoro.create(text, voice=voice, speed=1.0)
    except ValueError as e:
        # kokoro-onnx joins its batches with np.concatenate, which fails
        # like this when the text gives no phonemes at all
        if "need at least one array" in str(e):
            raise NoAudio() from e
        raise
    if samples is None or len(samples) == 0:
        raise NoAudio()
    return np.asarray(samples, dtype=np.float32), rate


def _synthesise(text: str, voice: str):
    """Samples for a whole page, chunk by chunk. Raises NoAudio if none of it speaks."""
    parts, rate = [], None
    for chunk in split_text(text):
        if not is_speakable(chunk):
            continue
        try:
            samples, chunk_rate = _speak(chunk, voice)
        except NoAudio:
            continue
        if rate is None:
            rate = chunk_rate
        if parts:
            parts.append(np.zeros(int(rate * CHUNK_GAP), dtype=np.float32))
        parts.append(samples)
    if not parts:
        raise NoAudio()
    return np.concatenate(parts), rate


def _silence():
    return np.zeros(SILENCE_SECONDS * SILENCE_RATE, dtype=np.float32), SILENCE_RATE


def _write_page(mp3: bytes, storage_key: str, output_path: str) -> str | None:
    with _write_lock:
        if storage_key in _cancelled:
            return None
        os.makedirs(audio_dir(storage_key), exist_ok=True)
        # Write to a temp file first so a half-written page is never served
        tmp_path = output_path + ".part"
        with open(tmp_path, "wb") as f:
            f.write(mp3)
        os.replace(tmp_path, output_path)
    return output_path


def text_to_audio(text: str, storage_key: str, page: int,
                  voice: str = "af_heart", book_id: int | None = None) -> str | None:
    """
    Convert a single page's text to MP3, always at speed 1.0.
    Skips generation if audio already exists. A page with nothing
    speakable gets the silent placeholder. Other errors are raised
    (the worker retries, then uses the placeholder).
    Returns path to the .mp3 file, or None if the book was deleted.
    """
    output_path = _audio_path(storage_key, page, voice)
    if os.path.exists(output_path):
        return output_path
    if not is_speakable(text):
        samples, sample_rate = _silence()
    else:
        try:
            samples, sample_rate = _synthesise(text, voice)
        except NoAudio:
            log.warning("Book %s page %s: Kokoro made no audio, using %s s of silence",
                        book_id if book_id is not None else storage_key, page + 1, SILENCE_SECONDS)
            samples, sample_rate = _silence()
    return _write_page(samples_to_mp3(samples, sample_rate), storage_key, output_path)


def silent_page(storage_key: str, page: int, voice: str = "af_heart") -> str | None:
    """Write the silent placeholder for a page that failed. None if the book was deleted."""
    samples, sample_rate = _silence()
    return _write_page(samples_to_mp3(samples, sample_rate), storage_key,
                       _audio_path(storage_key, page, voice))


def get_audio_path(storage_key: str, page: int,
                   voice: str = "af_heart") -> str | None:
    """
    Return the audio path if it already exists, otherwise None.
    Used by the UI to check if a page is ready instantly.
    """
    path = _audio_path(storage_key, page, voice)
    return path if os.path.exists(path) else None


def is_cancelled(storage_key: str) -> bool:
    return storage_key in _cancelled


def delete_book_audio(storage_key: str):
    """
    Stop any further audio for a book and delete its audio folder.
    Called when user deletes a book from the library.
    """
    with _write_lock:
        _cancelled.add(storage_key)
        shutil.rmtree(audio_dir(storage_key), ignore_errors=True)


def list_voices() -> list[str]:
    """Return available Kokoro voices."""
    return list(VOICES)
