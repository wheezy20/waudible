import os
import shutil
import threading
import numpy as np
from kokoro_onnx import Kokoro
from app.audio_codec import check_ffmpeg, samples_to_mp3
from app.storage import audio_dir

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


def _audio_path(storage_key: str, page: int, voice: str) -> str:
    """Build a consistent file path for a page's audio file (one per voice)."""
    return os.path.join(audio_dir(storage_key), f"page{page}_v{voice}.mp3")


def text_to_audio(text: str, storage_key: str, page: int,
                  voice: str = "af_heart") -> str | None:
    """
    Convert a single page's text to MP3, always at speed 1.0.
    Skips generation if audio already exists.
    Returns path to the .mp3 file, or None if the book was deleted.
    """
    output_path = _audio_path(storage_key, page, voice)
    if os.path.exists(output_path):
        return output_path
    if not text or text == "[This page has no readable text]":
        # Short silent placeholder for empty pages
        samples, sample_rate = np.zeros(22050, dtype=np.float32), 22050
    else:
        samples, sample_rate = kokoro.create(text, voice=voice, speed=1.0)
    mp3 = samples_to_mp3(samples, sample_rate)

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
