# Caramel favicon — OLD vs NEW

**Site:** grabcaramel.com · **App:** `apps/caramel-app`

## What was wrong (OLD)

- `favicon.ico` was a **rounded orange tile with heavy padding** — the "C" mark sat small inside its frame, so at real tab sizes (16–32px) it looked tiny and **soft/blurry** (poor space utilization).
- `caramel.svg` (the source) is the opposite extreme — a **hard, full-bleed square** with sharp 90° corners, i.e. a solid orange block in the tab.
- Neither balanced _fill the frame_ with _soft, transparent corners_.

## What changed (NEW)

- New **full-bleed rounded tile** (`rx ≈ 18%`) in brand orange `#eb6927` with the brand "C" — the mark now **fills the frame edge-to-edge** while keeping **cleanly transparent rounded corners** (verified on a checkerboard/alpha background).
- Regenerated **crisp** from vector at every size via `sharp` (no blur), and a **multi-resolution `favicon.ico`** (16/32/48) so browsers pick the sharpest.
- Added a scalable **`icon.svg`** and an **`apple-touch-icon.png`** (180) and wired both in `app/layout.tsx` metadata (previously only `favicon.ico` was referenced).

## Result

At 16px the "C" is noticeably larger and legible; corners are transparent (no white/opaque box) on both light and dark tabs.

## Files

- `OLD/` — original `favicon.ico`, `caramel.svg`
- `NEW/` — `favicon.ico` (16/32/48), `icon.svg`, `apple-touch-icon.png`, plus `icon-{16..512}.png`
- Shipped into `apps/caramel-app/public/`: `favicon.ico`, `icon.svg`, `apple-touch-icon.png`

## Not touched (optional follow-up)

- The PWA install icon set under `public/app/**` (Android/iOS/Windows tiles) referenced by `manifest.json` was left as-is; can be regenerated from the same `icon.svg` in a follow-up if desired.
- `caramel.svg` (brand square, used elsewhere) left unchanged; the rounded favicon lives in the new `icon.svg`.
