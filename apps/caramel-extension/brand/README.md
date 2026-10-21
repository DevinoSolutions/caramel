# Caramel brand icons

One vector master drives every app icon. The look is the Caramel Discord server
logo (owner rule 2026-10-20, T-4981): the script "C" of the wordmark in glossy
cream with a soft rim light and inner/drop shadows on the brand orange
(`#EE6929`, sampled from the Discord icon) tile, with a light inner edge glow
and a faint top gloss.

- `icon-master.svg` - the master (1024 viewBox, squircle tile). Written by the generator.
- `icon-master-1024.png` - 1024 PNG export of the master.
- `generate-icons.py` - the only way these files are produced. Every PNG is
  rasterised straight from SVG at its own size (resvg); nothing is upscaled.
- `requirements-icons.txt` - pinned Python deps (install into a venv outside the repo).
- `original.png` - 2048 full-bleed square, the Safari/App Store source that
  `.github/workflows/scripts/generate-safari-icons.sh` rounds itself.
- `generated/ios/AppIcon.appiconset` - 1024 full-bleed, opaque, no baked corners.
- `generated/macos/AppIcon.appiconset` - macOS grid, 824 tile in a 1024 canvas with its shadow margin.
- `generated/android` - adaptive layers (432 px, C inside the 66dp safe zone),
  monochrome layer, `ic_launcher.xml`, 512 Play Store icon.
- `Caramel Logos/` - legacy raster/SVG pack, kept for reference only.

Also written in place (same filenames and sizes): `public/icons/*.png` (the
extension icons `wxt.config.ts` declares) and, in `apps/caramel-app/public`,
`favicon.ico`, `icons/*`, `square_caramel_logo.png`, `app/ios`, `app/android`
(maskable-safe full-bleed) and `app/windows11`.

## Regenerate

```sh
python -m venv "$TEMP/caramel-icons-venv"
"$TEMP/caramel-icons-venv/Scripts/python" -m pip install -r apps/caramel-extension/brand/requirements-icons.txt
"$TEMP/caramel-icons-venv/Scripts/python" apps/caramel-extension/brand/generate-icons.py          # write
"$TEMP/caramel-icons-venv/Scripts/python" apps/caramel-extension/brand/generate-icons.py --check  # verify
```

(`bin/python` instead of `Scripts/python` on macOS/Linux.) Lint with
`ruff check` / `ruff format --check` / `ty check` on the script.

## Changing the look

Edit `C_PATH`/the filter constants in `generate-icons.py`, rerun, review the
diff, commit the regenerated files together.
