"""One-off: convert existing WAV page audio to MP3 and delete the WAVs.

Stop the app before running it. Safe to run more than once.

    python convert_wav_to_mp3.py              # converts data/audio
    python convert_wav_to_mp3.py --dry-run    # only shows what it would do
    python convert_wav_to_mp3.py /some/dir    # converts another folder

Names:
    <key>/page<N>_spd1.0_v<voice>.wav   ->  <key>/page<N>_v<voice>.mp3
    <old>_page<N>_spd1.0_v<voice>.wav   ->  <old>_page<N>_v<voice>.mp3  (old local app)

Audio is now always generated at speed 1.0 and the browser changes speed,
so WAVs made at other speeds are deleted instead of converted.
Delete this script from the repo once it has been run.
"""
import os
import re
import sys

from app.audio_codec import check_ffmpeg, file_to_mp3
from app.storage import AUDIO_DIR

WAV_NAME = re.compile(r"^(?P<prefix>.*?)page(?P<page>\d+)_spd(?P<speed>[\d.]+)_v(?P<voice>\w+)\.wav$")


def mb(n: int) -> str:
    return f"{n / 1024 / 1024:.1f} MB"


def main():
    args    = [a for a in sys.argv[1:] if a != "--dry-run"]
    dry_run = "--dry-run" in sys.argv[1:]
    root    = os.path.abspath(args[0] if args else AUDIO_DIR)
    check_ffmpeg()

    converted = skipped = removed = unknown = 0
    wav_bytes = mp3_bytes = 0

    for folder, _dirs, files in os.walk(root):
        for name in sorted(files):
            if not name.endswith(".wav"):
                continue
            wav_path = os.path.join(folder, name)
            rel      = os.path.relpath(wav_path, root)
            match    = WAV_NAME.match(name)
            if not match:
                print(f"left alone (unknown name): {rel}")
                unknown += 1
                continue

            size = os.path.getsize(wav_path)
            if float(match["speed"]) != 1.0:
                print(f"remove (speed {match['speed']}, no longer used): {rel}")
                if not dry_run:
                    os.remove(wav_path)
                removed += 1
                continue

            mp3_path = os.path.join(folder, f"{match['prefix']}page{match['page']}_v{match['voice']}.mp3")
            if os.path.exists(mp3_path):
                # Already converted (e.g. a second run interrupted before the delete)
                print(f"remove (MP3 already exists): {rel}")
                if not dry_run:
                    os.remove(wav_path)
                skipped += 1
                continue

            if dry_run:
                print(f"would convert: {rel}  ({mb(size)})")
                converted += 1
                continue

            file_to_mp3(wav_path, mp3_path)
            os.remove(wav_path)
            new_size = os.path.getsize(mp3_path)
            wav_bytes += size
            mp3_bytes += new_size
            converted += 1
            print(f"converted: {rel}  {mb(size)} -> {mb(new_size)}")

    verb = "would convert" if dry_run else "converted"
    print(f"\n{verb} {converted}, already done {skipped}, other speeds removed {removed}, "
          f"unknown names left alone {unknown}")
    if converted and not dry_run:
        print(f"converted WAVs: {mb(wav_bytes)} -> MP3s: {mb(mp3_bytes)} "
              f"({100 * mp3_bytes / wav_bytes:.0f}% of the original size)")


if __name__ == "__main__":
    main()
