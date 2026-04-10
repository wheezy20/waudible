import os
import threading
import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

# ─────────────────────────────────────────
# PATHS
# ─────────────────────────────────────────
AUDIO_DIR = os.path.join(os.path.dirname(__file__), '..', 'data', 'audio')
os.makedirs(AUDIO_DIR, exist_ok=True)

# ─────────────────────────────────────────
# LOAD KOKORO MODEL ONCE
# ─────────────────────────────────────────
print("Loading Kokoro voice model...")
kokoro = Kokoro("kokoro-v1.0.onnx", "voices-v1.0.bin")
print("Voice model ready!")

# ─────────────────────────────────────────
# PROCESSING STATE
# Tracks which books are being processed
# and how many pages are done
# ─────────────────────────────────────────
processing_state = {}
# Example of what this looks like at runtime:
# {
#   "mybook.pdf": {
#       "total": 200,
#       "done": 45,
#       "running": True
#   }
# }


def _audio_path(filename: str, page: int, speed: float, voice: str) -> str:
    """Build a consistent file path for a page's audio file."""
    safe_name = filename.replace(" ", "_").replace("/", "_")
    return os.path.join(AUDIO_DIR, f"{safe_name}_page{page}_spd{speed}_v{voice}.wav")


def text_to_audio(text: str, filename: str, page: int, speed: float = 1.0, voice: str = "af_heart") -> str:
    """
    Convert a single page's text to audio.
    Skips generation if audio already exists.
    Returns path to the .wav file.
    """
    output_path = _audio_path(filename, page, speed, voice)
    if os.path.exists(output_path):
        return output_path
    if not text or text == "[This page has no readable text]":
        # Generate a short silent placeholder for empty pages
        silent = np.zeros(22050, dtype=np.float32)
        sf.write(output_path, silent, 22050)
        return output_path
    samples, sample_rate = kokoro.create(text, voice=voice, speed=speed)
    sf.write(output_path, samples, sample_rate)
    return output_path


def get_audio_path(filename: str, page: int, speed: float = 1.0, voice: str = "af_heart") -> str | None:
    """
    Return the audio path if it already exists, otherwise None.
    Used by the UI to check if a page is ready instantly.
    """
    path = _audio_path(filename, page, speed, voice)
    return path if os.path.exists(path) else None


def _background_worker(pages: list[str], filename: str, speed: float, voice: str):
    """
    Internal function that runs in a background thread.
    Processes every page of the book one by one.
    """
    total = len(pages)
    processing_state[filename] = {"total": total, "done": 0, "running": True}

    for i, text in enumerate(pages):
        # Stop early if book was deleted
        if not processing_state.get(filename, {}).get("running", False):
            break
        text_to_audio(text, filename, page=i, speed=speed, voice=voice)
        processing_state[filename]["done"] = i + 1

    processing_state[filename]["running"] = False


def start_background_processing(pages: list[str], filename: str, speed: float = 1.0, voice: str = "af_heart"):
    """
    Launch background thread to pre-process all pages into audio.
    Called immediately after a PDF is uploaded.
    """
    # Don't start a second thread if already running
    if processing_state.get(filename, {}).get("running", False):
        return
    thread = threading.Thread(
        target=_background_worker,
        args=(pages, filename, speed, voice),
        daemon=True  # Thread dies automatically if app is closed
    )
    thread.start()


def get_processing_status(filename: str) -> dict:
    """
    Return current processing progress for a book.
    Used by the UI to show the progress bar.
    """
    if filename not in processing_state:
        return {"total": 0, "done": 0, "running": False}
    return processing_state[filename]


def delete_book_audio(filename: str):
    """
    Delete ALL audio files belonging to a book.
    Called when user deletes a book from the library.
    """
    # Stop background processing if running
    if filename in processing_state:
        processing_state[filename]["running"] = False

    safe_name = filename.replace(" ", "_").replace("/", "_")
    deleted = 0
    for f in os.listdir(AUDIO_DIR):
        if f.startswith(safe_name):
            os.remove(os.path.join(AUDIO_DIR, f))
            deleted += 1
    print(f"Deleted {deleted} audio files for '{filename}'")


def list_voices() -> list[str]:
    """Return available Kokoro voices."""
    return [
        "af_heart",
        "af_nova",
        "am_adam",
        "am_echo",
        "bf_emma",
        "bm_george",
    ]