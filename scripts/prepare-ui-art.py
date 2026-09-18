#!/usr/bin/env python3
"""Prepare the artwork from PR #25 for the live UI (not needed at runtime).

Install Pillow, then run this file from any directory. The source PNGs stay
untouched; checked-in WebP derivatives are served directly from /img/ui/.
Crops keep mock scores, rewards, English instructions and matchmaking metadata
out of the live interface. Real labels and values remain HTML, not image text.
"""

from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "img" / "ui"
# Source-pixel crop boxes; maximum output size is enough for 2x mobile displays.
ARTWORK = {
    "mascot-crash": (None, (384, 384)),
    "trophy-new-best": (None, (384, 384)),
    # "game-over-banner" was removed from the UI at the owner's request: the
    # ordinary GAME OVER card shows no illustration, so it is no longer derived.
    "pvp-battle-banner": ((180, 86, 1196, 595), (640, 400)),
    "pvp-searching": ((160, 20, 1248, 602), (640, 400)),
    "pvp-win": (None, (384, 384)),
    # Only the tap / pipe-opening illustrations; scoring is explained in HTML.
    "how-to-play": ((70, 222, 526, 587), (640, 400)),
    "referral-friends": ((0, 0, 1584, 672), (768, 400)),
}


def prepare(name, crop, size):
    source = ROOT / "img" / (name + ".png")
    with Image.open(source) as original:
        image = original.convert("RGBA")

    if name == "mascot-crash":
        # The source is RGB with a *painted* checkerboard, not transparency.
        # Mask just inside the medal rim, with an antialiased edge.
        alpha = Image.new("L", image.size, 0)
        ImageDraw.Draw(alpha).ellipse((26, 26, 996, 996), fill=255)
        image.putalpha(alpha.filter(ImageFilter.GaussianBlur(1)))
    elif name == "pvp-searching":
        # Remove the mock 72% progress and English labels inside the portal.
        # The UI places live, decorative search dots in this transparent area.
        cutout = Image.new("L", image.size, 0)
        ImageDraw.Draw(cutout).ellipse((480, 224, 928, 492), fill=255)
        image.putalpha(ImageChops.invert(cutout.filter(ImageFilter.GaussianBlur(6))))

    if crop:
        image = image.crop(crop)
    image.thumbnail(size, Image.Resampling.LANCZOS)
    if image.getchannel("A").getextrema() == (255, 255):
        image = image.convert("RGB")
    destination = DEST / (name + ".webp")
    image.save(destination, "WEBP", quality=84, method=6)
    return source.stat().st_size, destination.stat().st_size, image.size


def main():
    DEST.mkdir(parents=True, exist_ok=True)
    source_bytes = output_bytes = 0
    for name, (crop, size) in ARTWORK.items():
        before, after, dimensions = prepare(name, crop, size)
        source_bytes += before
        output_bytes += after
        print(f"{name}.webp: {dimensions[0]}x{dimensions[1]}, {after:,} bytes")
    print(f"Total: {source_bytes:,} → {output_bytes:,} bytes "
          f"({100 * (1 - output_bytes / source_bytes):.1f}% smaller)")


if __name__ == "__main__":
    main()
