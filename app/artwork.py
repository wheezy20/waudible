import subprocess
import fitz

# ─────────────────────────────────────────
# SQUARE ARTWORK FOR LOCK SCREENS
# The Media Session API (notification bar, lock screen)
# wants square images. Covers are portrait, so they are
# letterboxed on the app's dark background. Books without
# a cover get the same initials design as the library.
# ─────────────────────────────────────────
ARTWORK_SIZES = (96, 192, 512)

BG     = (0x11, 0x11, 0x11)
CARD   = (0x2a, 0x2a, 0x2a)
ORANGE = (0xE9, 0x54, 0x20)


def cover_artwork(path: str, size: int) -> bytes:
    """Letterbox a JPG, PNG or WebP cover into a size x size PNG (ffmpeg)."""
    vf = (f"scale={size}:{size}:force_original_aspect_ratio=decrease,"
          f"pad={size}:{size}:(ow-iw)/2:(oh-ih)/2:color=0x111111")
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
         "-i", path, "-vf", vf, "-frames:v", "1",
         "-f", "image2pipe", "-vcodec", "png", "pipe:1"],
        capture_output=True, check=True, timeout=20,
    )
    return result.stdout


def fallback_artwork(title: str, size: int) -> bytes:
    """Initials on a dark card with an orange bar, like the library's covers."""
    rgb = lambda c: tuple(v / 255 for v in c)
    doc  = fitz.open()
    page = doc.new_page(width=size, height=size)
    page.draw_rect(page.rect, color=None, fill=rgb(CARD))
    page.draw_rect(fitz.Rect(0, 0, size, size * 0.03), color=None, fill=rgb(ORANGE))

    initials = (title or "?")[:2].upper()
    fontsize = size * 0.38
    width    = fitz.get_text_length(initials, fontname="hebo", fontsize=fontsize)
    page.insert_text(((size - width) / 2, size / 2 + fontsize * 0.35), initials,
                     fontname="hebo", fontsize=fontsize, color=rgb(ORANGE))
    return page.get_pixmap(alpha=False).tobytes("png")
