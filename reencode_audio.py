"""Re-encode existing page audio to the current MP3 bitrate (one-off).

    python reencode_audio.py              # dry run: what would change, sizes
    python reencode_audio.py --convert    # do it

Every MP3 under the audio folder (data/audio, or WAUDIBLE_DATA_DIR/audio)
whose bitrate is above MP3_BITRATE_KBPS is re-encoded with the app's own
settings (app/audio_codec.py) into a temporary file, which then replaces
the original, so a page is never half written. File names stay the same.
Files already at the target bitrate are skipped, so it is safe to run
twice. A file that disappears meanwhile (its book was deleted) is skipped.

Re-encoding MP3 to MP3 loses a little quality on top of the first
encoding. Regenerating a page from its PDF with Kokoro avoids that, but
takes far longer (see JOURNAL.md, 26 Nov 2026).
"""
import argparse
import os
import subprocess
import sys

# Only what is needed: no Kokoro, no database
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from app.audio_codec import MP3_BITRATE_KBPS, check_ffmpeg, file_to_mp3   # noqa: E402

DATA_DIR  = os.environ.get("WAUDIBLE_DATA_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
AUDIO_DIR = os.path.join(DATA_DIR, "audio")
TARGET    = MP3_BITRATE_KBPS * 1000


def bitrate(path: str) -> int | None:
    """The audio stream's bitrate in bits per second, or None if unreadable."""
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
                          "stream=bit_rate", "-of", "default=nw=1:nk=1", path],
                         capture_output=True, text=True).stdout.strip()
    return int(out) if out.isdigit() else None


def mp3_files():
    if not os.path.isdir(AUDIO_DIR):
        return
    for folder in sorted(os.listdir(AUDIO_DIR)):
        path = os.path.join(AUDIO_DIR, folder)
        if not os.path.isdir(path):
            continue
        for name in sorted(os.listdir(path)):
            if name.endswith(".mp3"):
                yield os.path.join(path, name)


def mb(n: int) -> str:
    return f"{n / 1e6:.1f} MB"


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--convert", action="store_true", help="re-encode (without it, only report)")
    args = parser.parse_args()
    check_ffmpeg()

    total = before = after = 0
    todo = skipped = failed = unreadable = 0
    for path in mp3_files():
        total += 1
        try:
            size = os.path.getsize(path)
        except FileNotFoundError:
            continue
        before += size
        rate = bitrate(path)
        if rate is None:
            unreadable += 1
            after += size
            continue
        if rate <= TARGET * 1.02:       # already at (or below) the target
            skipped += 1
            after += size
            continue
        todo += 1
        if not args.convert:
            after += round(size * TARGET / rate)      # estimate
            continue
        try:
            file_to_mp3(path, path)                     # temp file, then rename
            after += os.path.getsize(path)
        except (subprocess.CalledProcessError, FileNotFoundError, OSError) as e:
            failed += 1
            after += size if os.path.exists(path) else 0
            print(f"  skipped {os.path.relpath(path, DATA_DIR)}: {type(e).__name__}")

    action = "re-encoded" if args.convert else "would be re-encoded (dry run, add --convert)"
    print(f"Audio folder: {AUDIO_DIR}")
    print(f"MP3 files: {total}; at {MP3_BITRATE_KBPS} kbps already: {skipped}; {action}: {todo - failed}"
          + (f"; failed: {failed}" if failed else "") + (f"; unreadable: {unreadable}" if unreadable else ""))
    print(f"Total size before: {mb(before)}")
    print(f"Total size after:  {mb(after)}" + ("" if args.convert else " (estimated)"))


if __name__ == "__main__":
    main()
