# Evidence 2026-10-21 (PROVE lane)

Headed stealth-browser checks of grabcaramel.com (prod, release fb6dcde) and dev.grabcaramel.com (fb6dcde). Screenshots only; no secrets, no coupon codes.

## Growth card (#385), favicon (#392), motion (#381/#382)
- growth-card-360-bottom-sheet.png: grabcaramel.com at 360px, caramel_visits=2; "Get Caramel for Chrome" card is a full-width bottom sheet (left 0, right 360).
- growth-card-desktop-corner.png: same page at desktop; 352px corner card bottom-right (left 1032, right 1384 of 1428).
- favicon-served-192.png / favicon-ico-48-enlarged.png / favicon-served.ico: icons actually served (/icons/caramel-icon-192.png, /favicon.ico 16/32/48): glossy cream script C on orange tile (Discord-logo look). The header logo is still the script wordmark (not the tile icon).
- faq-open-normal-motion.png, faq-open-reduced-motion.png: /faq item opened. Computed style normal: animation motion-faq-answer-rise 0.18s; with prefers-reduced-motion: reduce emulated: motion-faq-answer-fade 0.00001s, transform none (screens are the settled open state; the numbers come from getComputedStyle).
- dialog-open-normal-motion.png, dialog-open-reduced-motion.png: /support dialog opened. Normal: motion-dialog-scale 0.16s, backdrop motion-dialog-fade 0.15s. Reduced: motion-dialog-fade 0.00001s, no transform, backdrop animation none.

## Native app OAuth (#395/#396), account deletion, revoke
- dev-google-authorize-redirect-uri-mismatch.png: FAIL. dev authorize with app redirect + S256 returns a Google URL; Google shows redirect_uri_mismatch (T-5888).
- dev-apple-authorize.png: dev Apple authorize page "Sign in to Caramel Web" (client com.grabcaramel.signin, redirect dev.../api/extension/oauth/redirect). Not continued.
- dev-account-delete-and-revoke.png: dev throwaway account: two password bearers, DELETE /api/extension/session on #1 -> revoked, #1 401 / #2 200, POST /api/account/delete -> 200 deleted, then 401 and login 401.
- prod-google-authorize.png: prod authorize followed to the Google account chooser ("to continue to grabcaramel.com").
- prod-apple-authorize.png: prod Apple authorize page. Not continued.
- prod-account-delete-and-revoke.png: same lifecycle on prod with a throwaway account (deleted by itself).
- prod-402-code-binding-probes.png: prod (fb6dcde, #402): token exchange with a raw or forged cb1 code under an app state -> 400 "Authorization code does not belong to this sign-in"; wrong verifier -> 400 "Invalid or missing code_verifier". No session minted.

## Analytics
- posthog-code-share-funnel-by-reason-version.png: posthog.devino.ca Caramel project, event extension_code_share_funnel since 2026-10-20 by step/reason/ext_version. Only 1.4.15 and 1.4.16 appear; the only refusal reason is not-committed (18); no 1.4.17 data yet.

## T-5448 local files (prefix 5448-)
5448-*.png and 5448-results.txt come from the T-5448 local proof (worktree run), see results.txt.

## T-5888 dev Google client switch (2026-10-21 21:40Z)
- `t5888-a-app-authorize-chooser.png`: dev /api/extension/oauth/authorize (app redirect, real S256 PKCE) → Google account chooser, client 907782110658-onko… (was redirect_uri_mismatch, see dev-google-authorize-redirect-uri-mismatch.png).
- `t5888-b-dev-web-signed-in.png`: dev /login → Google → amin@devino.ca → back on dev.grabcaramel.com signed in; get-session 200. Test session deleted afterwards.

## PR #404 (T-5535 M4) local headed proof
- `pr404-3-quiet-404-card.png`: unknown coupon id → report 404 → quiet "That code is no longer listed." note, no error, no telemetry. Prod check follows the deploy.

## #403 (T-5535 M5) + #404 (T-5535 M4) LIVE on prod 5ae6de5 (deploy 22:00–22:03Z)
- Backups first: 2026-10-21T19-54-18-307Z and 2026-10-21T21-05-20-946Z. Rollback = fb6dcde.
- health, /, /login, /coupons/stores all 200 (0.19–0.36 s).
- `pr403-prod-login.png`: prod /login?code=PROBE403CODE&state=PROBE403STATE in a headed clone. The live client reports release 5ae6de5 and sendDefaultPii false. A handled probe error carrying the URL, an email and an IP became Sentry CARAMEL-2C with the message "…/login?code=[Filtered]&state=[Filtered] contact [Filtered email] from [Filtered ip]", Users 0, no request headers. CARAMEL-2C was resolved as test data. No other new issues in the 30 min after the deploy.
- #404: curl POST /api/coupons/999999999/report → 404 {"error":"Unknown coupon"}.
- `pr404-prod-quiet-404.png`: on the prod /coupons/ebay.com card, the report was rewritten to id 999999999 and other coupon POSTs were blocked (no prod write). "Yes, it worked" sent one 404 and showed the quiet note "That code is no longer listed." The buttons were gone, no vote was kept in localStorage, and there was no uvf marker.
