# DRAFT - privacy / data-safety answers for com.devino.caramel (Android 1.5.0 native app; 1.6.0 WebView shell changes it, see below)

Status: DRAFT for the owner. Derived from the code at `origin/main` d7af267 (PR #465 merged later as 95b4535; the app code described is the #465 head 8d82c07, whose files are unchanged by the merge). Not submitted anywhere.

## READ FIRST - 1.6.0 (WebView shell, T-7842) changed the facts below

Everything under "What the app does with the network" and the two forms was derived from the **1.5.0 native app**. In 1.6.0 the app
shows grabcaramel.com in a WebView, so these answers are **no longer all true and must be re-derived before any submission**:

- **Third-party analytics / tracking SDKs, device IDs, cookies:** the native code still has no SDK, but the WebView loads the
  website, which runs Google Analytics (`gtag`), PostHog-style first-party tracking and Sentry on its own pages
  (`apps/caramel-app/src/app/providers.tsx`). The rows that say "No" for analytics, device or other IDs, and "Only grabcaramel.com
  is contacted" are therefore **unverified for 1.6.0** and probably wrong for the web layer. Owner/web team to decide what the
  WebView may load (consent, a no-analytics app mode) and re-answer the forms. The native request list below is still accurate for
  sign-in only.
- **Network calls:** the catalog, savings, favorites and export calls listed below are no longer made by the app; the web pages make
  their own. The app itself only calls `GET /api/extension/oauth/authorize`, `POST /api/extension/oauth`, `GET /api/extension/me`,
  `DELETE /api/extension/session` (and `POST /api/account/delete`, currently unreachable, see below).
- **Stored on device:** the saved-store list (SharedPreferences) is gone. What stays: the Keystore-encrypted session token, plus
  whatever cookies and storage the WebView keeps for grabcaramel.com (app-private, excluded from backup).
- **Account and data deletion / export:** the native Account screen (export, delete synced data) was removed; a small native "Account & privacy" dialog (top-bar icon) keeps sign out, **Delete my account** (POST /api/account/delete, confirmation step) and the privacy policy. The
  Deletion is therefore in-app only (Play account-deletion policy): the dialog's "Delete my account" calls `SessionStore.deleteAccount`
  (`TODO(T-7505)`: it can move to the web once the web deletion page exists). Data export and "delete synced data" are gone from the app.
- **Signed-in web pages:** after the native sign-in the app trades its session bearer for a one-time (60 s) link
  (`POST /api/app/web-session/handoff`, T-7852) and opens it in the WebView, which then holds a grabcaramel.com session cookie so
  favorites and savings work. Sign-out and account deletion wipe that cookie and the WebView storage. Not yet run on a device.
- Source paths in the tables below that name `ui/AccountScreen.kt`, `core/FavoritesStore.kt` or `OnboardingScreen.kt` point at code
  that no longer exists; see git history at `95b4535` for the 1.5.0 versions.

Privacy policy URL: https://grabcaramel.com/privacy (HTTP 200, checked with curl 2026-10-24).
Server-side facts (what grabcaramel.com stores) come from the existing, already-reviewed `docs/store-listing.md` (CWS privacy tab,
2026-10-15) and `apps/caramel-app/src/components/PrivacyPolicy.tsx`; they must match this file. Paths below are under
`apps/caramel-android/app/src/main/` unless noted.

## What the app does with the network (the facts every answer rests on)

| Fact                                                                                                                       | Evidence                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Only permission is `INTERNET`. No location, contacts, storage, camera, phone, ad-id, notifications permission.             | `AndroidManifest.xml:6`; staged APK badging lists only `INTERNET` plus the app-private `...DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` (`fire-check.md`) |
| Cleartext HTTP is off; one API host, `https://grabcaramel.com`.                                                            | `AndroidManifest.xml:11`, `java/com/devino/caramel/core/AppConfig.kt:6`                                                                                |
| Every request carries a random per-request id header `x-request-id` (a fresh UUID, not a device id).                       | `core/CaramelApi.kt:106` (id from `UUID.randomUUID()`)                                                                                                 |
| Signed-in requests carry `Authorization: Bearer <session token>`.                                                          | `core/CaramelApi.kt:107`                                                                                                                               |
| Redirects are not followed (a bearer is never replayed elsewhere).                                                         | `core/CaramelApi.kt:59`                                                                                                                                |
| No ads, no analytics/crash SDK, no Firebase, no Play Services, no Play Billing: only AndroidX, Compose, kotlinx libraries. | dependency list in `fire-check.md`; `app/build.gradle.kts` dependencies; dex/manifest scan = 0 hits                                                    |
| Sign-in is OAuth in the browser (Chrome Custom Tab), PKCE S256; the app never sees a Google/Apple password.                | `MainActivity.kt:78`, `core/CaramelApi.kt:213-236`, `core/SignIn.kt`                                                                                   |
| Session token is AES-GCM encrypted under a non-exportable Android Keystore key, kept in app-private storage.               | `core/Persistence.kt:45-122` (`ANDROID_KEYSTORE`, `AES/GCM/NoPadding`, alias `caramel_session_key`)                                                    |
| Saved-store list is kept in app-private SharedPreferences; excluded from cloud backup and device transfer.                 | `core/Persistence.kt:22`, `res/xml/data_extraction_rules.xml`, `AndroidManifest.xml:10,12` (`allowBackup=false`)                                       |
| Nothing is collected for signed-out use beyond what the public catalog calls imply (see "Browsing" below).                 | `core/CaramelApi.kt:140-157`                                                                                                                           |

### What each call sends (all to grabcaramel.com, `core/CaramelApi.kt`)

- Signed out: `GET /api/coupons/recently-worked`, `/api/sites/top-sites`, `/api/coupons/stores?q=<typed search text>&limit=`
  (line 148), `/api/coupons?site=<store domain>&page=&limit=` (line 153). So the **text the shopper types in Search and the store
  domain they open** reach the server (no account attached). The server sees the request IP like any HTTP request.
- Sign-in: `GET /api/extension/oauth/authorize?provider&redirect_uri&code_challenge...` (213-221) and
  `POST /api/extension/oauth` with the code, state, redirect and PKCE verifier (224-236). The server then holds the account's
  provider-supplied name, email, image and provider id (per `docs/store-listing.md`, PII row).
- Signed in: `GET /api/extension/me`, `GET /api/account/overview` (163: savings totals, member-since), `GET/PUT/DELETE
/api/account/favorites[/store]` (167-175: the saved-store list), `GET /api/account/export`, `POST /api/account/data/delete`,
  `POST /api/account/delete`, `DELETE /api/extension/session` (180-201).
- The Android app **never sends** savings events, cart contents, page content, browsing history, contacts, files or device
  identifiers. (The savings figures shown come from events the browser extension recorded; the app only reads totals.)

## Play Console - Data safety form (draft answers)

Overall:

- Does the app collect or share any of the required user data types? **Yes (collects), No (shares).** No data is sold or shared
  with third parties for their own use. Only grabcaramel.com (the developer's own server) receives data; no third-party SDK is
  present to receive any.
- Is all of the user data collected by your app encrypted in transit? **Yes** (HTTPS only: `usesCleartextTraffic=false`).
- Do you provide a way for users to request that their data be deleted? **Yes** - in the app (Account tab: "Delete my synced
  data", "Delete my account", `ui/AccountScreen.kt:138-142`, calls `core/CaramelApi.kt:187,200`) and via the web:
  . Account-deletion URL to give Play: https://grabcaramel.com/privacy, because the only web path today is the email process
  described there (`PrivacyPolicy.tsx:466`: email hello@devino.ca from the account address; deletion acted on within 30 days).
  `/profile` is NOT a deletion page: web account deletion is deliberately absent and `/profile` only deletes synced data
  (`DataPrivacySection.tsx:19-24`). **[BLOCKER for the Play form until a dedicated web deletion page exists - tracked as
  T-7505.]** The in-app path is verified in code only, not on a device.

| Data type (Play category)                                                                 | Collected?                 | Shared? | Required or optional           | Purpose            | Evidence                                                                                                                         |
| ----------------------------------------------------------------------------------------- | -------------------------- | ------- | ------------------------------ | ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Personal info: Name                                                                       | Yes (only when signed in)  | No      | Optional (sign-in is optional) | Account management | OAuth result `OAuthSessionResult.username`, `core/Models.kt (OAuthSessionResult)`; shown on `AccountScreen.kt:110`               |
| Personal info: Email address                                                              | Yes (only when signed in)  | No      | Optional                       | Account management | Held server-side from the provider (`docs/store-listing.md` PII row); the app itself reads no email                              |
| Personal info: User IDs (account/provider id)                                             | Yes (only when signed in)  | No      | Optional                       | Account management | Same OAuth exchange, `core/CaramelApi.kt:224-236`                                                                                |
| Photos and videos / profile picture                                                       | Yes (image URL, signed in) | No      | Optional                       | Account management | `MeResponse.image`, `core/Models.kt:67`. Declare under "Personal info" if Play has no better bucket                              |
| App activity: Other user-generated content / app interactions                             | Yes (signed in)            | No      | Optional                       | App functionality  | Saved-store list synced to the account: `core/FavoritesStore.kt`, `core/CaramelApi.kt:167-175`                                   |
| App activity: In-app search history                                                       | Yes (even signed out)      | No      | Required for Search to work    | App functionality  | Search text sent as `q=` (`core/CaramelApi.kt:148`). Not stored per user by the app; server-side retention: **owner to confirm** |
| Financial info: Purchase history / other financial info (savings)                         | Not collected by this app  | No      | n/a                            | n/a                | The app only **reads** savings totals (`GET /api/account/overview`); savings events are written by the extension, not the app    |
| Device or other IDs                                                                       | **No**                     | n/a     | n/a                            | n/a                | No ad id, no Android id, no install id in code; `x-request-id` is a random per-request UUID, not persisted (`CaramelApi.kt:106`) |
| Location, Contacts, Messages, Photos/files, Audio, Calendar, Health, Web browsing history | **No**                     | n/a     | n/a                            | n/a                | No permission or API for any of them (`AndroidManifest.xml`)                                                                     |
| App info and performance (crash logs, diagnostics)                                        | **No**                     | n/a     | n/a                            | n/a                | No crash/analytics SDK. See TODO in `CaramelApplication.kt` (no reporting yet). Play-collected vitals are Google's, not declared |

Notes for the owner:

- IP address: the server receives and uses it for rate limiting and records it with sign-in sessions (`docs/store-listing.md`,
  Location row). Play's form does not have a separate "IP address" row; the CWS tab ticked "Location" for the same reason. Decide
  whether to declare it the same way here **[owner decision]**.
- "Shared" is No everywhere: grabcaramel.com is the developer's own backend (a service provider processing for the app's own function).
- Security practices: data encrypted in transit **Yes**; deletion mechanism **Yes**; Families/ads: **no ads**; "independent
  security review": **No**.
- Target audience: general audience, not a children's app.

## Amazon Appstore - privacy questionnaire (draft answers)

Amazon's exact questions could not be read (the console is off limits), so these follow the usual Appstore topics; re-check against
the live form.

| Topic                                 | Draft answer                                                                                                                                     | Evidence                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| Privacy policy URL                    | https://grabcaramel.com/privacy (HTTP 200)                                                                                                       | curl 2026-10-24                                    |
| Collects personal information         | Yes, only if the shopper signs in: name, email, profile image, provider id. Optional.                                                            | rows above                                         |
| Shares data with third parties        | No. Only grabcaramel.com (the developer) is contacted.                                                                                           | `AppConfig.kt:6`, no SDKs                          |
| Uses advertising / ad identifiers     | No                                                                                                                                               | no ad SDK, no ad-id permission                     |
| Third-party analytics / tracking SDKs | No                                                                                                                                               | `fire-check.md` scan                               |
| In-app purchases / subscriptions      | No (free; no billing code)                                                                                                                       | `fire-check.md` scan for billing = 0               |
| Location                              | Not accessed                                                                                                                                     | manifest                                           |
| Contacts, camera, microphone, storage | Not accessed. Data export is saved through the system file picker (`ActivityResultContracts.CreateDocument`), which needs no storage permission. | `ui/AccountScreen.kt:71`; manifest                 |
| Device identifiers                    | Not collected                                                                                                                                    | code review above                                  |
| Data encrypted in transit             | Yes, HTTPS only                                                                                                                                  | `AndroidManifest.xml:11`                           |
| Data stored on device                 | Saved-store list (SharedPreferences, app-private) and the encrypted session token (Android Keystore AES-GCM). No backup of either.               | `core/Persistence.kt`, `data_extraction_rules.xml` |
| Account / data deletion               | In-app account deletion and synced-data deletion; data export                                                                                    | `ui/AccountScreen.kt:136-142`                      |
| Google Mobile Services dependency     | None (works on Fire OS)                                                                                                                          | `fire-check.md`                                    |
| Children                              | Not directed to children                                                                                                                         | n/a                                                |

## Things to settle before submitting

1. Retention (`PrivacyPolicy.tsx:305-309`): session records, which carry the IP, are kept until the account is deleted; per-code report hashes for 30 days; server logs, which can include IPs, up to 90 days. The policy does not say how long the search text (`q=`) is kept in those logs: confirm.
2. Whether to declare IP address like the CWS tab does (see notes).
3. A public support email (see `listing.md`).
4. The privacy policy page should name the Android app before the listing goes live; `PrivacyPolicy.tsx` (no mention of Android or the iOS app found by grep) currently
   describes the extension (`docs/store-listing.md` says they change together). That is a `caramel-app` edit and was NOT made in this PR.
5. Sign-in has not been exercised on a device; the deletion path is verified in code and unit tests, not end to end on Android.
