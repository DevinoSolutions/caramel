# DRAFT - Amazon Appstore / Play listing for Caramel (com.devino.caramel)

Status: DRAFT. Owner approval is needed before any of this is pasted into a console. Nothing here has been submitted.
Prepared for T-7474, revised for T-7842. Version described: Android 1.6.0 (`versionName` in `apps/caramel-android/app/build.gradle.kts`), the WebView shell.

## The one rule for this copy

The Android app is a **container**: since 1.6.0 (T-7842) it shows grabcaramel.com's own coupon pages (Deals `/coupons`, Search
`/coupons/stores`, Saved `/profile#favorites`, Account `/profile`) inside a WebView with native sign-in. It lists codes and
lets the shopper copy them. It does NOT apply codes at checkout, because there is no Android extension. So the extension's
"auto-apply at checkout" claims are deliberately left out below. Every sentence is traceable to the web pages the tabs show
or to existing public copy (cited). Anything not already public is flagged **[NEW CLAIM - owner to approve]**.

**Not verified in the 1.6.0 WebView:** the app has not been run on a device or emulator, so the web pages' behaviour inside the
shell (copy buttons, saving a store, the Account page) is taken from the web app's code, not observed. Verify before submitting.

Source key:

- EXT = `apps/caramel-extension/scripts/store-listing.mjs` (public extension store text, claim-audited 2026-10-05)
- WEB = the grabcaramel.com pages the tabs open (`apps/caramel-app/src/app/(marketing)/coupons/`, `apps/caramel-app/src/app/profile/`)
- SHELL = `apps/caramel-android/app/src/main/java/com/devino/caramel/` (`ui/CaramelApp.kt`, `web/`)
- SUP = `apps/caramel-app/src/app/(marketing)/support/page.tsx:60-63` and `apps/caramel-app/src/lib/supportCopy.ts:5`
- The 1.5.0 native Kotlin screens (Deals, Search, Store, Saved, Account, Get started) were removed in 1.6.0; older drafts cited
  them as ONB / UI.

## Amazon fields

### Title

`Caramel`

(EXT's long extension titles carry "Honey Alternative" / "Promo Codes" SEO terms and are not reused. If a longer title is
wanted, `Caramel: Coupon Finder & Promo Codes` is the existing Safari name, EXT `SAFARI_NAME`.)

### Short description

> Find coupon codes for the stores you shop at, tap a code to copy it, and save your favorite stores.

- "find coupon codes for the stores you shop at": WEB `/coupons` and `/coupons/stores` (coupon list, popular stores, store index).
- "copy them": WEB `components/coupons/coupon-card.tsx` (copy action on each code). Not observed inside the WebView.
- "save your favorite stores": WEB `components/coupons/store-favorite-star.tsx` and `/profile#favorites`. Saving needs an account on
  the web, so the old "on this device" wording is gone.

100 characters. Amazon's field limit is not verified (the console is off limits); it is under the 132 the Chrome Web Store allows.

### Long description

> Caramel finds coupon codes for the stores you shop at.
>
> - Deals: browse coupon codes and popular stores.
> - Search: look up a store by name or domain and see its codes. Tap Copy to copy a code, then paste it at that store's checkout.
> - Saved stores: sign in to keep the stores you care about across devices.
> - Free: Caramel is free. There are no purchases in the app.
> - No data selling: Caramel doesn't sell your data. You can browse Deals and Search without an account.
> - Open source: the full code is public under the AGPL-3.0 license at github.com/DevinoSolutions/caramel.
>
> Sign in with Apple or Google (optional) to sync your saved stores and see what Caramel has saved you.
>
> Questions or something not working? See the Support page at grabcaramel.com/support: a human replies within 1 business day.

Claim trace:

- Deals / Search / Saved / copy: WEB pages above, shown by SHELL `web/ShellRoutes.kt` (`ShellTab`).
- "Free", "no purchases": EXT ("Caramel is free"); the app has no billing path (billing-gate grep in PR #465).
- "doesn't sell your data", "without an account": EXT bullets; Deals and Search are public web pages (no session needed).
  "Only talks to grabcaramel.com" was dropped: the WebView can follow a link out to a retailer, and `ExternalLinkPolicy` then opens
  it in the browser, so the app itself does not browse other sites, but the claim is not worth the risk.
- "Open source ... AGPL-3.0 ... github.com/DevinoSolutions/caramel": EXT bullet.
- Sign in with Apple or Google: SHELL `ui/CaramelApp.kt` (sign-in sheet) and `core/SessionStore.kt`. Sync and savings: WEB `/profile`
  once the web session handoff exists (**TODO T-7852: not built yet, so a signed-in app does not yet show a signed-in `/profile`; do
  not submit before it does**).
- Support sentence: SUP, "a human replies within 1 business day".
- REMOVED vs the 1.5.0 draft: "download your data, delete your synced data, or delete your account from inside the app". The native
  Account screen that did this is gone and the web `/profile` has no account deletion (`privacy.md`, T-7505).

Deliberately NOT claimed (the Android app does not do it): auto-applying codes at checkout, comparing totals, savings read from
the cart, a toolbar badge, affiliate-link handling, cashback or rewards (EXT says Caramel has none), push notifications,
price tracking.

### Product feature bullets (Amazon "product features")

1. Coupon codes for the stores you shop at, in one place
2. Deals tab: browse coupon codes and popular stores
3. Search any store by name or domain, then tap to copy a code
4. Save favorite stores; sign in (optional) to keep them across devices
5. Free, open source (AGPL-3.0), and no data selling

Each maps to a sentence above. Amazon's per-bullet limit is not verified.

### Keywords

`coupon, coupons, promo codes, discount codes, deals, savings` (trim to Amazon's limit when the form is open; the limit is not
verified). "Honey" is intentionally not used as an Android keyword: it would be a **[NEW CLAIM - owner to approve if wanted]**.

### Category suggestion

Amazon Appstore: **Shopping**. (Play: Shopping, to be confirmed in Play Console; not changed here.)

### Support

- Support URL: https://grabcaramel.com/support (HTTP 200, checked with curl 2026-10-24).
- Support email: `hello@devino.ca` is the address published on the privacy page
  (`apps/caramel-app/src/components/PrivacyPolicy.tsx:466`). The support form's own recipient is a private deploy env value
  (`apps/caramel-app/src/lib/env.ts` `SUPPORT_EMAIL_TO`), and a dedicated `support@grabcaramel.com` is still a TODO there.
  Whether to put `hello@devino.ca` on the Amazon form is **the owner's decision**.
- Privacy policy URL: https://grabcaramel.com/privacy (HTTP 200, checked with curl 2026-10-24).
- Website: https://grabcaramel.com

Owner note on "what Caramel has saved you": the Android app records no savings (only the browser extension does), so an
Android-only user sees no savings on the web Account page (`/profile`, not checked inside the WebView). The long description keeps that sentence limited to
"see what Caramel has saved you" for signed-in users who also use the extension; reword it if the listing should not
imply Android records savings.

### Other form facts

- Package `com.devino.caramel`, versionName 1.6.0. No ads, no in-app purchases (see `privacy.md`).
- Content rating: the owner answers the console questionnaire (a coupon-lookup utility, no user-generated content shown).
- Devices: phones and tablets, Fire OS 7+ (minSdk 26 excludes Fire OS 5/6; see `fire-check.md`).
- Icons: `icons/icon-512.png`, `icons/icon-114.png` (below). Screenshots: not produced, see `screenshots-TODO.md`.
- Universal APK for Amazon: workflow artifact `caramel-android-release` -> `app-release.apk` (release workflow).

## Icons

| File                 | Size                | Source                                                                                                                                           |
| -------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `icons/icon-512.png` | 512x512, opaque RGB | `apps/caramel-extension/brand/icon-master.svg` ("square" variant), rasterised by resvg at 512 px through `render()` in `brand/generate-icons.py` |
| `icons/icon-114.png` | 114x114, opaque RGB | the same SVG master, rasterised directly at 114 px (not scaled from the 512)                                                                     |

Nothing is upscaled. `icon-512.png` is pixel-identical to `apps/caramel-extension/brand/generated/android/play-store-512.png`
(`PIL.ImageChops.difference` bounding box empty). Rendered with the pinned `resvg-py==0.5.0` / `pillow==13.0.0`
(`brand/requirements-icons.txt`) in a venv outside the repo. The brand pack itself is not modified.
