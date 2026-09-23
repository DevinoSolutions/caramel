# Store badges — provenance and usage terms

Every file in this directory is an **unmodified** official badge, downloaded from the
store owner's own badge page on **2026-09-22**. Nothing here is redrawn, traced or
recoloured: the house rule (shared with uNotes) is that if an official asset cannot be
obtained, the page keeps a generic glyph rather than shipping a lookalike, because a
lookalike is a trademark problem AND a lie about where the download goes.

The badges are rendered by `src/app/(marketing)/apps/AppsPageClient.tsx` via the
`badge` field on `src/app/(marketing)/apps/storeListings.ts`. Sizes there are a
height only (width is `auto`), so the artwork's own aspect ratio is never distorted.
`tests/unit/apps-store-listings.test.ts` checks every referenced file exists and
carries a real PNG/SVG signature (the first Chrome download was a 404 page saved
with a `.png` name — that is the failure the check exists for).

## Chrome Web Store

| file                                 | source URL                                                                                  | px        |
| ------------------------------------ | ------------------------------------------------------------------------------------------- | --------- |
| `chrome-web-store-border-large.png`  | `https://developer.chrome.com/static/docs/webstore/branding/image/HRs9MPufa1J1h5glNhut.png` | 496 × 150 |
| `chrome-web-store-border-medium.png` | `https://developer.chrome.com/static/docs/webstore/branding/image/iNEddTyWiMfLSwFD6qGq.png` | 340 × 96  |

Both are the "Available in the Chrome Web Store" badge **with border** ("for colored
backgrounds") from <https://developer.chrome.com/docs/webstore/branding>. The large
one is what the page renders; the medium one is kept for the growth-prompt card if it
ever carries artwork. Terms read on that page: use only the supplied badge, do not
alter it, keep its aspect ratio; the badge must link to the extension's Chrome Web
Store listing.

## Firefox Add-ons

| file                        | source URL                                                                    | viewBox  |
| --------------------------- | ----------------------------------------------------------------------------- | -------- |
| `firefox-get-the-addon.svg` | `https://blog.mozilla.org/addons/files/2020/04/get-the-addon-fx-apr-2020.svg` | 172 × 60 |

The "Get the Add-on" badge Mozilla published for developers in the Add-ons Blog post
"Get your extension a badge" (April 2020) — the only badge asset Mozilla provides.
Terms: link it to the add-on's AMO listing; do not modify.

## Microsoft Edge Add-ons

| file                            | source                                                                                                                                              | px         |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `microsoft-edge-add-ons-en.png` | `English_Get it from Microsoft Edge.png` inside `Microsoft_Edge_Add-ons_badge_image_files.zip` (microsoft/MicrosoftEdge-Extensions repo, `assets/`) | 1178 × 312 |

Documented at
<https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/add-ons-badge>.
Quoted rules: "Always use the official badge artwork provided by Microsoft", "Do not
… modify the badge in any way", "The badge must always be an active, clickable link
that directs users to your product detail page at the Microsoft Edge Add-ons
website", minimum size **32 px**, keep the aspect ratio. The page renders it at
44 px high. The "Coming soon" state greys the badge with a CSS filter and renders
NO link — permitted because the artwork bytes are untouched and nothing pretends to
be a store link.

## Safari — App Store

| file                              | source URL                                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| `apple-app-store-black-en-us.svg` | `https://toolbox.marketingtools.apple.com/api/v2/badges/download-on-the-app-store/black/en-us` |

Apple's own App Store Marketing Tools badge service (the asset the "Download the
badge" control on <https://developer.apple.com/app-store/marketing/guidelines/>
serves; uNotes verified it byte-identical to
`developer.apple.com/assets/elements/badges/download-on-the-app-store.svg`). Terms:
use only Apple's artwork, minimum **40 px** onscreen, clear space of one quarter the
badge height, never translate or modify, and when badges for other platforms appear
"use the preferred black badge" and "place the App Store badge first in the lineup"
— which is why only the black variant is vendored and why Safari leads the declared
order in `storeListings.ts` (the visitor's own browser is then hoisted per visit).

## Trademarks

Apple, the Apple logo and App Store are trademarks of Apple Inc. Chrome and the
Chrome Web Store badge are trademarks of Google LLC. Firefox is a trademark of the
Mozilla Foundation. Microsoft Edge is a trademark of the Microsoft group of
companies. These badges are used solely to link to Caramel's own listings.
