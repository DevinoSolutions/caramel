"""Regenerate every Caramel app icon from ONE vector master (no raster upscaling).

Run from anywhere (repo root shown):

    python -m venv "$TEMP/caramel-icons-venv"
    "$TEMP/caramel-icons-venv/Scripts/python" -m pip install -r apps/caramel-extension/brand/requirements-icons.txt
    "$TEMP/caramel-icons-venv/Scripts/python" apps/caramel-extension/brand/generate-icons.py

(on macOS/Linux the interpreter is `venv/bin/python`). Add `--check` to fail if any
committed output differs from what this script would write.

The look is the Discord server logo (owner rule 2026-10-20, T-4981): the script C
from the Caramel wordmark in a glossy cream gradient with a soft rim light and
soft inner/drop shadows, on the brand orange tile (#EE6929, sampled from the
Discord icon) with a light inner edge glow and a faint top gloss.

Source of truth: `C_PATH` below. It is the italic script "C" of the wordmark, the
same outline as apps/caramel-app/public/caramel.svg (192 unit viewBox). Every PNG
is rasterised straight from SVG at its own size (resvg), so nothing is upscaled.

Outputs
-------
brand/icon-master.svg            the master (squircle tile, 1024 viewBox)
brand/icon-master-1024.png       its 1024 PNG export
brand/original.png               2048 full-bleed square, the Safari/App Store source
                                 (.github/workflows/scripts/generate-safari-icons.sh)
brand/generated/ios/             AppIcon.appiconset: 1024 full-bleed, opaque, no rounded corners
brand/generated/macos/           AppIcon.appiconset: Apple macOS grid (824 tile in 1024, shadow margin)
brand/generated/android/         adaptive icon layers (432px, C inside the 66dp safe zone),
                                 monochrome layer, adaptive XML, 512 Play Store icon
public/icons/                    extension toolbar/store icons (wxt.config.ts ICONS), same sizes
../caramel-app/public/...        favicon.ico, icons/, square_caramel_logo.png, app/ios,
                                 app/android, app/windows11 (same filenames and sizes)
"""

from __future__ import annotations

import argparse
import io
import json
import math
import struct
import sys
from pathlib import Path
from typing import Literal

import resvg_py
from PIL import Image

BRAND_DIR = Path(__file__).resolve().parent
EXTENSION_DIR = BRAND_DIR.parent
APP_PUBLIC_DIR = EXTENSION_DIR.parent / "caramel-app" / "public"

# Italic script "C" of the Caramel wordmark, 192 unit viewBox (from caramel.svg).
C_PATH = "M69.29,94.72c-.22,3.23-.19,7.15-.17,10.94.03,5.25.59,10.19.71,11.31.6,5.63,1.45,9.1,2.64,13.3,3.63,12.8,12.45,17.89,24.46,15.19,20.44-4.6,32.65-18.86,39.68-39.07,1.18-3.37,1.96-6.9,3.11-10.28,1.3-3.82,3.42-6.95,7.52-7.56,5.52-.81,9.21,2.85,8.12,8.67-4.8,25.71-15.21,47.8-38.35,59.63-18.62,9.52-37.98,11.07-56.55-.77-10.5-6.7-16.25-17.58-19.17-29.93-5.23-22.08-4.93-44.07,3.16-65.4,5.45-14.37,14.07-26.06,28.05-31.79,13.03-5.34,31.17-4.19,39.48,7.89,4.14,6.02,6.86,12.75,7.24,20.31.23,4.63-2.18,8.37-5.39,9.03-2.94.6-6.11-2.04-7.61-6.44-.74-2.16-1.28-4.41-2.04-6.56-3.06-8.6-9.39-10.88-16.26-5.48-8.45,6.65-12.74,16.45-15.32,26.82-1.37,5.5-2.59,9.61-3.32,20.18Z"
# Its outline bounding box centre and farthest-point radius from that centre, in the
# 192 unit space (measured by rasterising C_PATH at 1920 px).
C_CENTER_X = 96.7
C_CENTER_Y = 95.2
C_HEIGHT = 138.6
C_MAX_RADIUS = 71.0

TILE_ORANGE = "#EE6929"  # sampled from the Discord server icon
CANVAS = 1024  # master viewBox, all geometry below is in this space

# C size on the tile: fraction of the tile height. Matches the Discord icon.
C_TILE_FRACTION = 0.74
# Android adaptive icons: visible mask is 72dp of 108dp, safe zone is a 66dp circle.
ANDROID_SAFE_RADIUS = (66 / 108) / 2
# PWA maskable icons: safe zone is a circle of radius 40 percent of the canvas.
MASKABLE_SAFE_RADIUS = 0.40

Variant = Literal[
    "squircle", "square", "macos", "foreground", "background", "monochrome"
]


def squircle_path(x: float, y: float, size: float, exponent: float = 4.5) -> str:
    """Superellipse |x|^n + |y|^n = 1 as a closed polygon path (Apple-like continuous corners)."""
    half = size / 2
    cx, cy = x + half, y + half
    steps = 160  # per quadrant; sagitta stays well under 0.1 px at 1024
    points: list[str] = []
    for i in range(steps * 4):
        theta = 2 * math.pi * i / (steps * 4)
        c, s = math.cos(theta), math.sin(theta)
        px = cx + half * math.copysign(abs(c) ** (2 / exponent), c)
        py = cy + half * math.copysign(abs(s) ** (2 / exponent), s)
        points.append(f"{px:.1f} {py:.1f}")
    return "M" + "L".join(points) + "Z"


def c_transform(scale: float) -> str:
    """Place the C bounding-box centre at the canvas centre, `scale` canvas units per path unit."""
    return (
        f"translate({CANVAS / 2} {CANVAS / 2}) scale({scale:.4f}) "
        f"translate({-C_CENTER_X} {-C_CENTER_Y})"
    )


def c_scale_for(variant: Variant, tile_size: float) -> float:
    if variant == "foreground" or variant == "monochrome":
        return ANDROID_SAFE_RADIUS * CANVAS / C_MAX_RADIUS
    return C_TILE_FRACTION * tile_size / C_HEIGHT


DEFS_COMMON = """
    <linearGradient id="c-body" x1="0" y1="0" x2="0.12" y2="1">
      <stop offset="0" stop-color="#FFFEFD"/>
      <stop offset="0.15" stop-color="#FFF4EF"/>
      <stop offset="0.43" stop-color="#FFECE1"/>
      <stop offset="0.57" stop-color="#FEE5D5"/>
      <stop offset="0.84" stop-color="#F9D3C1"/>
      <stop offset="1" stop-color="#F9D0BB"/>
    </linearGradient>
    <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.05"/>
      <stop offset="0.5" stop-color="#FFFFFF" stop-opacity="0"/>
      <stop offset="0.72" stop-color="#9A2F00" stop-opacity="0"/>
      <stop offset="1" stop-color="#9A2F00" stop-opacity="0.08"/>
    </linearGradient>
    <filter id="c-fx" x="-12%" y="-12%" width="124%" height="128%" color-interpolation-filters="sRGB">
      <feGaussianBlur in="SourceAlpha" stdDeviation="16" result="shadow-blur"/>
      <feOffset in="shadow-blur" dx="6" dy="18" result="shadow-offset"/>
      <feFlood flood-color="#B23F0A" flood-opacity="0.34"/>
      <feComposite in2="shadow-offset" operator="in" result="drop-shadow"/>
      <feFlood flood-color="#EC9B76" flood-opacity="0.75" result="shade-flood"/>
      <feComposite in="shade-flood" in2="SourceAlpha" operator="out" result="shade-outside"/>
      <feOffset in="shade-outside" dx="-12" dy="-16" result="shade-offset"/>
      <feGaussianBlur in="shade-offset" stdDeviation="13" result="shade-blur"/>
      <feComposite in="shade-blur" in2="SourceAlpha" operator="in" result="inner-shadow"/>
      <feFlood flood-color="#FFFFFF" result="rim-flood"/>
      <feComposite in="rim-flood" in2="SourceAlpha" operator="out" result="rim-outside"/>
      <feGaussianBlur in="rim-outside" stdDeviation="4" result="rim-blur"/>
      <feComponentTransfer in="rim-blur" result="rim-sharp">
        <feFuncA type="linear" slope="3.2"/>
      </feComponentTransfer>
      <feComposite in="rim-sharp" in2="SourceAlpha" operator="in" result="rim"/>
      <feMerge>
        <feMergeNode in="drop-shadow"/>
        <feMergeNode in="SourceGraphic"/>
        <feMergeNode in="inner-shadow"/>
        <feMergeNode in="rim"/>
      </feMerge>
    </filter>
"""

DEFS_EDGE_GLOW = """
    <filter id="tile-glow" x="-5%" y="-5%" width="110%" height="110%" color-interpolation-filters="sRGB">
      <feFlood flood-color="#FFA877" result="glow-flood"/>
      <feComposite in="glow-flood" in2="SourceAlpha" operator="out" result="glow-outside"/>
      <feGaussianBlur in="glow-outside" stdDeviation="11" result="glow-blur"/>
      <feComponentTransfer in="glow-blur" result="glow-strong">
        <feFuncA type="linear" slope="3"/>
      </feComponentTransfer>
      <feComposite in="glow-strong" in2="SourceAlpha" operator="in" result="glow"/>
      <feMerge>
        <feMergeNode in="SourceGraphic"/>
        <feMergeNode in="glow"/>
      </feMerge>
    </filter>
"""

DEFS_MACOS_SHADOW = """
    <filter id="tile-shadow" x="-10%" y="-10%" width="120%" height="125%" color-interpolation-filters="sRGB">
      <feGaussianBlur in="SourceAlpha" stdDeviation="12" result="blur"/>
      <feOffset in="blur" dx="0" dy="12" result="offset"/>
      <feFlood flood-color="#000000" flood-opacity="0.3"/>
      <feComposite in2="offset" operator="in"/>
    </filter>
"""


def build_svg(variant: Variant) -> str:
    """SVG for one variant, always a 1024 unit viewBox (render at any pixel size)."""
    tile_size = 824.0 if variant == "macos" else float(CANVAS)
    tile_x = (CANVAS - tile_size) / 2
    rounded = variant in ("squircle", "macos")
    tile_d = (
        squircle_path(tile_x, tile_x, tile_size)
        if rounded
        else f"M0 0H{CANVAS}V{CANVAS}H0Z"
    )
    defs = DEFS_COMMON
    if variant == "squircle" or variant == "macos":
        defs += DEFS_EDGE_GLOW
    if variant == "macos":
        defs += DEFS_MACOS_SHADOW
    defs += f'    <path id="tile-shape" d="{tile_d}"/>\n'

    scale = c_scale_for(variant, tile_size)
    parts: list[str] = []
    if variant != "foreground" and variant != "monochrome":
        if variant == "macos":
            parts.append('<use href="#tile-shape" filter="url(#tile-shadow)"/>')
        glow = ' filter="url(#tile-glow)"' if rounded else ""
        parts.append(f'<g{glow}><use href="#tile-shape" fill="{TILE_ORANGE}"/>')
        parts.append('<use href="#tile-shape" fill="url(#gloss)"/></g>')
    if variant == "monochrome":
        parts.append(
            f'<path transform="{c_transform(scale)}" d="{C_PATH}" fill="#000000"/>'
        )
    elif variant != "background":
        parts.append(
            f'<g filter="url(#c-fx)"><path transform="{c_transform(scale)}" '
            f'd="{C_PATH}" fill="url(#c-body)"/></g>'
        )
    body = "\n  ".join(parts)
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
        f'viewBox="0 0 {CANVAS} {CANVAS}">\n'
        f"  <defs>{defs}  </defs>\n  {body}\n</svg>\n"
    )


_svg_cache: dict[Variant, str] = {}


def render(variant: Variant, pixels: int, *, flatten: bool = False) -> Image.Image:
    """Rasterise `variant` at pixels x pixels straight from SVG. `flatten` drops alpha (RGB)."""
    svg = _svg_cache.setdefault(variant, build_svg(variant))
    png = bytes(resvg_py.svg_to_bytes(svg_string=svg, width=pixels, height=pixels))
    image = Image.open(io.BytesIO(png))
    image.load()
    rgba = image.convert("RGBA")
    if flatten:
        if min(rgba.getchannel("A").getextrema()) != 255:
            raise ValueError(
                f"{variant} at {pixels}px is not fully opaque; cannot flatten"
            )
        return rgba.convert("RGB")
    return rgba


class Writer:
    """Writes outputs, or in --check mode compares them to what is on disk."""

    def __init__(self, check: bool) -> None:
        self.check = check
        self.written: list[Path] = []
        self.mismatched: list[Path] = []

    def png(self, path: Path, image: Image.Image) -> None:
        buffer = io.BytesIO()
        image.save(buffer, format="PNG", optimize=True)
        self.raw(path, buffer.getvalue())

    def raw(self, path: Path, data: bytes) -> None:
        if self.check:
            if not path.exists() or path.read_bytes() != data:
                self.mismatched.append(path)
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        self.written.append(path)

    def text(self, path: Path, data: str) -> None:
        self.raw(path, data.encode("utf-8"))


def png_bytes(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def ico_bytes(sizes: list[int], variant: Variant) -> bytes:
    """Multi-frame .ico with one PNG frame per size, each rasterised from SVG."""
    frames = [png_bytes(render(variant, size)) for size in sizes]
    header = struct.pack("<HHH", 0, 1, len(sizes))
    offset = 6 + 16 * len(sizes)
    entries = b""
    for size, frame in zip(sizes, frames, strict=True):
        dimension = 0 if size >= 256 else size
        entries += struct.pack(
            "<BBBBHHII", dimension, dimension, 0, 0, 1, 32, len(frame), offset
        )
        offset += len(frame)
    return header + entries + b"".join(frames)


def old_art_box(path: Path) -> tuple[int, int, int, int]:
    """Bounding box (left, top, right, bottom) of the non-transparent art in an existing icon."""
    with Image.open(path) as existing:
        box = (
            existing.convert("RGBA")
            .getchannel("A")
            .point(lambda a: 255 if a > 8 else 0)
            .getbbox()
        )
    if box is None:
        raise ValueError(f"{path} has no visible pixels to take the tile layout from")
    return box


def windows_tile(path: Path) -> Image.Image:
    """Same canvas size and tile placement as the file it replaces, new artwork."""
    left, top, right, bottom = old_art_box(path)
    with Image.open(path) as existing:
        width, height = existing.size
    side = min(right - left, bottom - top)
    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    tile = render("squircle", side)
    canvas.alpha_composite(
        tile, (left + (right - left - side) // 2, top + (bottom - top - side) // 2)
    )
    return canvas


def maskable_scale() -> float:
    return MASKABLE_SAFE_RADIUS * CANVAS / C_MAX_RADIUS


def build_maskable_svg() -> str:
    """Full-bleed square with the C pulled inside the PWA maskable safe zone, if needed."""
    svg = build_svg("square")
    tile_scale = c_scale_for("square", float(CANVAS))
    if tile_scale <= maskable_scale():
        return svg
    return svg.replace(c_transform(tile_scale), c_transform(maskable_scale()))


def render_maskable(pixels: int) -> Image.Image:
    png = bytes(
        resvg_py.svg_to_bytes(
            svg_string=build_maskable_svg(), width=pixels, height=pixels
        )
    )
    image = Image.open(io.BytesIO(png))
    image.load()
    return image.convert("RGBA")


ANDROID_ADAPTIVE_XML = """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>
</adaptive-icon>
"""

IOS_CONTENTS = {
    "images": [
        {
            "filename": "icon-1024.png",
            "idiom": "universal",
            "platform": "ios",
            "size": "1024x1024",
        }
    ],
    "info": {"author": "xcode", "version": 1},
}

MACOS_POINT_SIZES = (16, 32, 128, 256, 512)


def generate(writer: Writer) -> None:
    # Master + the Safari/App Store source.
    writer.text(BRAND_DIR / "icon-master.svg", build_svg("squircle"))
    writer.png(BRAND_DIR / "icon-master-1024.png", render("squircle", 1024))
    writer.png(BRAND_DIR / "original.png", render("square", 2048, flatten=True))

    # iOS: full-bleed, opaque, no rounded corners (the OS masks it).
    ios_dir = BRAND_DIR / "generated" / "ios" / "AppIcon.appiconset"
    writer.png(ios_dir / "icon-1024.png", render("square", 1024, flatten=True))
    writer.text(ios_dir / "Contents.json", json.dumps(IOS_CONTENTS, indent=2) + "\n")

    # macOS: Apple grid, 824 tile centred in the 1024 canvas with its shadow margin.
    mac_dir = BRAND_DIR / "generated" / "macos" / "AppIcon.appiconset"
    images: list[dict[str, str]] = []
    for point in MACOS_POINT_SIZES:
        for scale in (1, 2):
            name = f"icon_{point}x{point}{'@2x' if scale == 2 else ''}.png"
            writer.png(mac_dir / name, render("macos", point * scale))
            images.append(
                {
                    "filename": name,
                    "idiom": "mac",
                    "scale": f"{scale}x",
                    "size": f"{point}x{point}",
                }
            )
    writer.text(
        mac_dir / "Contents.json",
        json.dumps(
            {"images": images, "info": {"author": "xcode", "version": 1}}, indent=2
        )
        + "\n",
    )
    writer.png(
        BRAND_DIR / "generated" / "macos" / "icon-1024-macos.png", render("macos", 1024)
    )

    # Android: adaptive layers (108dp at xxxhdpi = 432 px), Play Store 512, adaptive XML.
    android_dir = BRAND_DIR / "generated" / "android"
    writer.png(android_dir / "ic_launcher_foreground.png", render("foreground", 432))
    writer.png(
        android_dir / "ic_launcher_background.png",
        render("background", 432, flatten=True),
    )
    writer.png(android_dir / "ic_launcher_monochrome.png", render("monochrome", 432))
    writer.png(android_dir / "play-store-512.png", render("square", 512, flatten=True))
    writer.text(android_dir / "ic_launcher.xml", ANDROID_ADAPTIVE_XML)

    # Extension toolbar/store icons, same sizes wxt.config.ts declares (Chrome, Edge, Firefox, Safari).
    for size in (16, 19, 32, 38, 48, 128, 192, 512):
        writer.png(
            EXTENSION_DIR / "public" / "icons" / f"{size}.png", render("squircle", size)
        )

    # Site: favicon, touch icon, 192 PNG, full-bleed 600 source.
    writer.raw(APP_PUBLIC_DIR / "favicon.ico", ico_bytes([16, 32, 48], "squircle"))
    writer.png(
        APP_PUBLIC_DIR / "icons" / "caramel-icon-192.png", render("squircle", 192)
    )
    writer.png(
        APP_PUBLIC_DIR / "icons" / "apple-touch-icon-180.png",
        render("square", 180, flatten=True),
    )
    writer.png(APP_PUBLIC_DIR / "square_caramel_logo.png", render("square", 600))

    # PWA icon sets: same filenames and sizes as before.
    for path in sorted((APP_PUBLIC_DIR / "app" / "ios").glob("*.png")):
        with Image.open(path) as existing:
            size = existing.size[0]
        writer.png(path, render("squircle", size))
    for path in sorted((APP_PUBLIC_DIR / "app" / "android").glob("*.png")):
        with Image.open(path) as existing:
            size = existing.size[0]
        writer.png(path, render_maskable(size))
    for path in sorted((APP_PUBLIC_DIR / "app" / "windows11").glob("*.png")):
        writer.png(path, windows_tile(path))


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--check", action="store_true", help="fail if outputs on disk differ"
    )
    args = parser.parse_args()
    writer = Writer(check=args.check)
    generate(writer)
    if args.check:
        if writer.mismatched:
            for path in writer.mismatched:
                print(f"out of date: {path}", file=sys.stderr)
            return 1
        print("all icon outputs match the generator")
        return 0
    print(f"wrote {len(writer.written)} files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
