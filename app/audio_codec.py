import os
import shutil
import subprocess
import numpy as np

# ─────────────────────────────────────────
# MP3 ENCODING WITH FFMPEG
# Always an argument list, never a shell string.
# Mono, 64 kbps is plenty for speech.
# ─────────────────────────────────────────
MP3_OUTPUT_ARGS = ["-ac", "1", "-codec:a", "libmp3lame", "-b:a", "64k", "-f", "mp3"]


def check_ffmpeg():
    """Fail at startup with a clear message if ffmpeg can't make MP3s."""
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg is not installed. Install it with: sudo apt install ffmpeg")
    encoders = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"],
                              capture_output=True, text=True).stdout
    if "libmp3lame" not in encoders:
        raise RuntimeError("ffmpeg was found but has no MP3 encoder (libmp3lame). "
                           "Install the full build with: sudo apt install ffmpeg")


def samples_to_mp3(samples, sample_rate: int) -> bytes:
    """Encode mono float samples (as Kokoro returns them) to MP3 bytes."""
    pcm = np.asarray(samples, dtype="<f4").tobytes()
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error",
         "-f", "f32le", "-ar", str(sample_rate), "-ac", "1", "-i", "pipe:0",
         *MP3_OUTPUT_ARGS, "pipe:1"],
        input=pcm, capture_output=True, check=True,
    )
    return result.stdout


def file_to_mp3(src_path: str, dst_path: str):
    """
    Convert an audio file to MP3. Writes to a temp file and renames,
    so dst_path is either complete or absent.
    """
    tmp_path = dst_path + ".part"
    try:
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
             "-i", src_path, *MP3_OUTPUT_ARGS, tmp_path],
            capture_output=True, check=True,
        )
        os.replace(tmp_path, dst_path)
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
