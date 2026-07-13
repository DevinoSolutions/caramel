# CHANGE-TRACE: Empirical Coupling Test

**Repo**: caramel (dev @ 537547b3081aa3a0ec817cdc5f6dac4f0d328dbb)
**Date**: 2026-07-10
**Method**: For each invented feature, trace the exact files/modules that must change to ship it, using only what the code actually does today (verified by reading every touched file — no assumption carried over from naming alone). Coupling and duplication claims are backed by verbatim quotes with file:line. `audit/exclusions.md` honored (migrations, lockfiles, binaries, `.git` excluded from grading; their _existence_ as artifacts is still noted where relevant).

---

## SMALL — "Add an expiration-date badge next to each coupon on the app's coupons page"

### (a) Exact file list

| File                                                      | Role                                                                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/caramel-app/src/components/coupons/coupon-card.tsx` | Renders one coupon card (discount badge, title, description, usage count, verification badge, copy button). Add the new expiry badge here. |

That's the entire list. No type file, no API route, no SQL query needs to change.

**Why**: `coupon.expiry` already exists end-to-end before this feature is written:

- Type already declared — `apps/caramel-app/src/types/coupon.ts:21`: `expiry: string`
- Already selected by the browse-page API — `apps/caramel-app/src/app/api/coupons/route.ts:93-96`:
    ```
    SELECT id, code, site, title, description, rating,
           discount_type, discount_amount, expiry, expired,
           times_used AS "timesUsed",
    ```
- Already selected by the SSR store-page query — `apps/caramel-app/src/app/(marketing)/coupons/[store]/page.tsx:50-52` (identical column list).
- `coupon-card.tsx` currently never reads `coupon.expiry` at all (confirmed by full read — it only touches `discount_amount`, `title`, `description`, `timesUsed`, `status`, `code`).
- `coupons-section.tsx` passes the whole `coupon` object through as a prop (`<CouponCard coupon={coupon} index={index} />`, line 330-334) without touching individual fields, so no intermediate file is in the path.
- No date-formatting library exists in the app (`grep -l 'date-fns\|dayjs\|moment' package.json` → 0 matches), so the badge would format the ISO string inline — a code-quality note, not a coupling one.

### (b) File count + module count

**1 file, 1 module** (`components/coupons`).

### (c) Unrelated code dragged in

None. Both fetch paths that feed this component already carry the field; nothing outside `coupon-card.tsx` needs to move.

### (d) Duplication tax

None identified. `CouponCard` has exactly one render site (`coupons-section.tsx`'s `.map()`); there is no second hand-rolled coupon-list renderer in the app to keep in sync.

### (e) Change isolation score: **9/10**

Essentially a single-file, single-component change with the data already flowing to it. The one point held back: `coupon.expiry` is dual-purpose in the data model — `apps/caramel-app/src/app/api/coupons/expire/route.ts:51-53` overwrites it to `NOW()::text` when a coupon is administratively killed (`expiry = NOW()::text` alongside `expired = TRUE`). That's a latent semantic trap for whoever writes the badge (not a file-coupling problem — `expired` rows are already excluded from every visible query — but a maintainer reading only the column name could render a killed coupon's kill-timestamp as if it were a real future expiry, if the `expired` filter were ever dropped from a query).

---

## MEDIUM — "Show the user's lifetime total savings (sum across all sessions/applies) on the account/profile page"

### (a) Exact file list

| File                                                                                 | Role                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/caramel-app/prisma/schema.prisma`                                              | Add a new model (e.g. `CouponApply { id, userId, site, amountSaved, appliedAt }`) + a relation array on `User`. **Nothing today persists a coupon-apply event anywhere.**                                       |
| `apps/caramel-app/prisma/migrations/<new>/` (generated)                              | Migration artifact of the schema change above (excluded from content-grading per `exclusions.md`; its creation is still mandatory).                                                                             |
| `apps/caramel-app/src/app/api/extension/coupon-applied/route.ts` (**new**)           | Authenticated POST the extension calls after a real apply, to write one `CouponApply` row.                                                                                                                      |
| `apps/caramel-app/src/app/api/account/savings/route.ts` (**new**, illustrative name) | Authenticated GET that sums `CouponApply.amountSaved` for the signed-in user, for the profile page to call.                                                                                                     |
| `apps/caramel-app/src/app/profile/ProfilePageClient.tsx`                             | Add the "Lifetime savings" stat block; currently renders only `name`/`email`/`firstName`/`lastName`/`username` (full read confirms no savings/activity field exists).                                           |
| `apps/caramel-extension/shared-utils.js`                                             | The apply-attempt loop (~lines 1327-1473) computes `bestSave`/`bestCode` at the moment of success; must dispatch a new message with that outcome.                                                               |
| `apps/caramel-extension/background.js`                                               | Needs a new message handler that reads the stored auth token and POSTs to the new endpoint — **this file currently never reads `storage.sync` at all** (verified: 0 matches for `storage.` in `background.js`). |

### (b) File count + module count

**7 files** (1 schema + 1 migration artifact + 2 new app routes + 1 profile UI + 2 extension files) across **5 modules**: Prisma data layer, app API layer, profile UI, extension apply-flow, extension background/messaging.

### (c) Unrelated code dragged in

**Edge 1 — the only existing "Session" concept is an auth artifact, not a usage-activity log.** A developer reaching for the word "session" (as the feature literally does — "sum across all their sessions/applies") finds this instead:

```
model Session {
    id        String   @id @default(cuid())
    expiresAt DateTime @map("expires")
    token     String   @unique @map("session_token")
    createdAt DateTime @default(now())
```

`apps/caramel-app/prisma/schema.prisma:30-34` — token/expiry/IP fields for better-auth login sessions, unrelated to coupon activity. Building "lifetime savings" on/near this model would conflate auth state with product analytics.

**Edge 2 — the only "require a logged-in user" abstraction is dead and framework-incompatible**, so the new authenticated routes get no reuse:

```
import { NextApiRequest, NextApiResponse } from 'next'
```

`apps/caramel-app/src/lib/middlewares/withAuth.ts:2` — a Pages-Router signature (`NextApiRequest`/`NextApiResponse`). Every real route in this repo is an App-Router handler, e.g. `apps/caramel-app/src/app/api/coupons/increment/route.ts:3`: `import { NextRequest, NextResponse } from 'next/server'`. Confirmed by repo-wide grep: `withAuth`/`withRoles` are imported by **zero** files outside their own definitions. The two new routes must hand-roll `auth.api.getSession(...)` from scratch.

**Edge 3 — the extension's identity state is popup-only today.** `storage.sync` (`token`, `user`) is read only by `popup.js` (5 call sites) and written once by `shared-utils.js`'s cross-origin login listener (line 1508); `background.js` touches it never. Piping an authenticated call through the content-script → background.js relay (the codebase's only existing outbound-fetch pattern, e.g. `fetchCoupons` in `background.js:177-204`) means teaching `background.js` to branch on guest-vs-logged-in for the first time — logic that today only exists inside `popup.js`'s `renderCouponsView` (guest vs. `@username` header, lines 571-587).

### (d) Duplication tax

The mutation-route boilerplate is already triplicated verbatim and the new authenticated endpoint becomes a 4th, harder copy (it also needs a session check none of the three have):

```
if (!isOriginAllowed(req)) return forbiddenOrigin()
const limited = await checkRateLimit(req, 'mutation')
```

`apps/caramel-app/src/app/api/coupons/increment/route.ts:13-14` — identical to `apps/caramel-app/src/app/api/sources/route.ts:73-74`, and to `apps/caramel-app/src/app/api/coupons/expire/route.ts:13` (+ line 21 for the rate-limit call, split by an API-key check). No shared "guarded mutation handler" helper exists — each route re-states the pair. The new `coupon-applied` route repeats this pattern _and_ invents session-checking fresh, because (per Edge 2) there is nothing to call.

### (e) Change isolation score: **3/10**

Sounds like "add a number to a page"; is actually "invent the entire persistence + auth-plumbing pipeline for user-tied product activity, from a standing start, across both apps." The low score is driven by the _absence_ of foundational plumbing (no user↔coupon-activity link, no reusable auth-check, no extension→server authenticated-write path), not by raw file count.

---

## CROSS-CUTTING — "Track per-store coupon success rate, persist it, rank extension try-order by it, surface it in app + extension popup"

### (a) Exact file list

| File                                                                                   | Role                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/caramel-app/src/lib/couponsDb.ts`                                                | Shared raw-SQL row type (`CouponRow`) for the `coupons` table. Add `attempts`/`success_rate`-shaped fields.                                                                                             |
| `apps/caramel-app/src/types/coupon.ts`                                                 | Independently-maintained frontend mirror of the same row shape (`Coupon` interface). Must add the matching field(s) _again_.                                                                            |
| `apps/caramel-app/src/app/api/coupons/route.ts`                                        | The one GET endpoint used by **both** the app's browse page **and** the extension's `fetchCoupons` relay. Must SELECT the new field and reweight `ORDER BY` by success rate.                            |
| `apps/caramel-app/src/app/(marketing)/coupons/[store]/page.tsx`                        | SSR store-page query. Duplicates route.ts's SELECT/ORDER BY today; must change in lockstep or the store page and the browse page disagree on ranking.                                                   |
| `apps/caramel-app/src/app/api/coupons/report-attempt/route.ts` (**new**, illustrative) | Endpoint the extension calls once per tried code with the outcome. The nearest existing analog, `/api/coupons/increment`, is dead code (see (c) Edge 4) — not safely extensible, realistically net-new. |
| `apps/caramel-app/src/components/coupons/coupon-card.tsx`                              | App UI. Add the success-rate badge — a **3rd** distinct badge concern on this one file, alongside the pre-existing `STATUS_BADGE` map and the SMALL feature's new expiry badge.                         |
| `apps/caramel-extension/shared-utils.js`                                               | The coupon-try loop (~1327-1473). Must report each attempt's outcome as it happens (mid-loop), not just a final summary.                                                                                |
| `apps/caramel-extension/background.js`                                                 | New message handler relaying attempt reports to the new endpoint.                                                                                                                                       |
| `apps/caramel-extension/popup.js`                                                      | Extension UI. Add the **same** success-rate badge to `renderCouponsView` (lines 568-695) — a 2nd, independently-styled copy of the app's new badge.                                                     |

Plus, **0 in-repo files / 1 external system**: the natural home for a `site`-keyed counter is the `caramel_coupons` Postgres database (it already has `coupons.site` and is what `route.ts`/`[store]/page.tsx` query) — but per `apps/caramel-app/src/lib/couponsDb.ts:1-6`, that database is **owned by a service whose source is not in this repository** (see (c) Edge 1). This repo's Prisma never touches it (no model, no migration).

### (b) File count + module count

**9 in-repo files** across 2 apps, **plus a mandatory out-of-band schema dependency on a database this repo doesn't own.**
**7 modules**: coupons-DB shared types, coupons ranking/read API, new attempt-reporting API, app coupon-list UI, extension apply-flow, extension background/messaging, extension popup UI — **plus** the externally-owned Python-service schema as a de facto 8th dependency outside the repo's control.

### (c) Unrelated code dragged in

**Edge 1 — cross-service database ownership.**

```
// Read-only connection to the `caramel_coupons` database owned by the
// Python verification service. All mutations to the coupon catalog flow
// through that service
```

`apps/caramel-app/src/lib/couponsDb.ts:2-4`. Persisting a new per-store counter durably means either a raw-SQL change to a schema this repo can't version, coordinated with an out-of-repo service, or moving the stat into the Prisma DB and merging two separate query results in application code.

**Edge 2 — a badge-map duplicate this feature would extend to a 3rd/4th copy.** App side:

```
const STATUS_BADGE: Record<CouponStatus, { label: string; cls: string }> = {
    valid: {
        label: '✓ Verified',
```

`apps/caramel-app/src/components/coupons/coupon-card.tsx:21-23`. Extension side, same 8 keys, same labels, different color system entirely:

```
const BADGE = {
    valid: ['✓ Verified', '#15803d', '#dcfce7'],
```

`apps/caramel-extension/popup.js:638-639`. "Surface the rate in both UIs" means writing a _third_ such map (Tailwind classes here, hex-color arrays there) rather than sharing one.

**Edge 3 — naming collision with an unrelated, already-shipped `successRate`.**

```
const denom = r.total_used + r.total_expired
const successRate =
    denom === 0 ? 0 : (r.total_used / denom) * 100
```

`apps/caramel-app/src/app/api/sources/route.ts:51-53` — a _scraper-source_ hit rate (per feed, not per store), computed live and never persisted. Anyone grepping "successRate" while building the per-store, persisted, attempt-based metric this feature asks for will land here first.

**Edge 4 — a misleading dead-code precedent.**

```
// 30/min — /increment, /expire, /sources POST. Extension calls
// /increment once per coupon copy, which is nowhere near this cap.
```

`apps/caramel-app/src/lib/rateLimit.ts:26-27`. Verified by repo-wide grep: **zero** callers of `/increment` exist anywhere in `apps/caramel-extension/**`, `local-dev/**`, or `.github/**`. `times_used` is therefore effectively always 0 in production. A developer might reasonably (and wrongly) assume attempt/usage telemetry is already flowing and try to build success-rate math on top of it.

### (d) Duplication tax

Ranking must change in exactly the two places that independently declare it today:

```
FROM coupons
WHERE ${whereClause}
ORDER BY rating DESC, created_at DESC
```

`apps/caramel-app/src/app/api/coupons/route.ts:97,99` — vs.

```
WHERE ${VISIBLE_STATUSES}
  AND (site = ${base} OR site LIKE ${'%.' + base})
ORDER BY rating DESC, created_at DESC
```

`apps/caramel-app/src/app/(marketing)/coupons/[store]/page.tsx:55-57`. The code's own comment (`[store]/page.tsx:43-45`) states these two queries exist "so SSR HTML and the client fetch agree (no hydration flash)" — i.e., the authors already know this pair must be kept in sync; a success-rate-weighted ORDER BY is a new value the same discipline must be applied to.

### (e) Change isolation score: **1/10**

The single worst-isolated of the three. It fans out through both apps' full depth (types → API → SQL ranking → UI, twice, in two different UI stacks) and — uniquely among the three — cannot be fully resolved by editing this repository alone: its natural data home is a database owned by an out-of-repo service.

---

## CANDIDATE FINDINGS

{"id":"CT-1","location":"apps/caramel-app/src/app/api/coupons/route.ts:99","quote":"ORDER BY rating DESC, created_at DESC","what":"The coupon ranking ORDER BY is written independently in two files (also apps/caramel-app/src/app/(marketing)/coupons/[store]/page.tsx:57) rather than a shared query builder.","why_it_matters":"Any future ranking change (this audit tested one: per-store success rate) must be applied twice by hand; the two UI surfaces (browse page vs. store page) will silently disagree if one edit is missed, despite the code's own comment saying they must agree.","severity":"Medium","confidence":0.9,"fix_direction":"Extract the shared WHERE/ORDER BY fragment into one couponsDb.ts helper both call sites import.","effort":"S","category":"duplication"}

{"id":"CT-2","location":"apps/caramel-app/src/components/coupons/coupon-card.tsx:21-34","quote":"const STATUS_BADGE: Record<CouponStatus, { label: string; cls: string }> = {\n valid: { label: '✓ Verified', cls: 'bg-green-100 text-green-700 ...' },","what":"The coupon verification-status label/color map is independently re-declared in apps/caramel-extension/popup.js:638-664 with the same 8 keys and labels but a different color representation (hex vs Tailwind classes).","why_it_matters":"Any status vocabulary change (add a status, reword a label, restyle) must be made twice, in two languages/styling systems, with no compiler or lint check tying them together — the two badges have already drifted in representation once and will drift in content eventually.","severity":"Medium","confidence":0.9,"fix_direction":"Define the status->{label,color} map once as plain JSON/data (not TS-only types) and load it from both the React component and the extension bundle.","effort":"M","category":"duplication"}

{"id":"CT-3","location":"apps/caramel-app/src/lib/couponsDb.ts:1-6","quote":"// Read-only connection to the `caramel_coupons` database owned by the\n// Python verification service. All mutations to the coupon catalog flow\n// through that service","what":"The entire coupon catalog (code, site, rating, times_used, expiry, status) lives in a Postgres database owned by a service whose source is not in this repository; this repo's Prisma schema/migrations never model it.","why_it_matters":"Any feature that needs a new persisted, coupon-or-store-keyed field (this audit needed one for per-store success rate) requires either an out-of-band schema change to a database this repo can't version-control, or awkward two-database application-level joins.","severity":"High","confidence":0.9,"fix_direction":"Document schema-change ownership/process explicitly (who runs migrations on caramel_coupons and how this repo tracks them), or migrate store-level aggregates into the Prisma-owned DB deliberately.","effort":"L","category":"architecture"}

{"id":"CT-4","location":"apps/caramel-app/src/lib/middlewares/withAuth.ts:2","quote":"import { NextApiRequest, NextApiResponse } from 'next'","what":"withAuth/withRoles are the only \"require a logged-in user\" helpers in the codebase, but they're written for the Next.js Pages Router (NextApiRequest/NextApiResponse) while every real route is an App Router handler (NextRequest/NextResponse, e.g. apps/caramel-app/src/app/api/coupons/increment/route.ts:3). Confirmed unused by repo-wide grep.","why_it_matters":"Any future authenticated API route (e.g. a per-user savings endpoint) has no reusable session-check helper to call and must hand-roll auth.api.getSession(...) inline, risking inconsistent 401 handling across routes.","severity":"Medium","confidence":0.85,"fix_direction":"Delete withAuth.ts/withRoles.ts if truly obsolete, or port them to the route-handler (req: NextRequest) signature so they're actually callable.","effort":"S","category":"architecture"}

{"id":"CT-5","location":"apps/caramel-app/src/lib/rateLimit.ts:26-27","quote":"// 30/min — /increment, /expire, /sources POST. Extension calls\n// /increment once per coupon copy, which is nowhere near this cap.","what":"This comment describes the extension calling /api/coupons/increment on every coupon copy. Repo-wide grep across apps/caramel-extension, local-dev, and .github finds zero callers of this endpoint anywhere.","why_it_matters":"times_used is therefore effectively always 0 in production; any future feature (e.g. success-rate math) that assumes usage telemetry is already flowing from this endpoint will silently compute against dead data.","severity":"Medium","confidence":0.85,"fix_direction":"Either wire the extension to call /increment on real applies, or delete the endpoint/comment so the next reader doesn't trust telemetry that isn't flowing.","effort":"S","category":"clarity"}

{"id":"CT-6","location":"apps/caramel-app/prisma/schema.prisma:56-78","quote":"model User {\n ...\n accounts Account[]\n sessions Session[]\n\n @@map(\"users\")\n}","what":"The User model has no relation to any coupon-catalog or coupon-activity data whatsoever — its only relations are auth Account/Session. There is no table anywhere recording that a specific user applied, tried, or saved money on a coupon.","why_it_matters":"Any \"my activity\" style feature (lifetime savings, apply history, favorite stores) starts from zero — there is no existing foundation, and the only similarly-named concept (Session) is an unrelated auth artifact a developer could mistakenly reach for or conflate with.","severity":"High","confidence":0.8,"fix_direction":"Introduce an explicit CouponApply (or similar) model with its own migration before building any per-user activity feature; keep it clearly separate from the auth Session model.","effort":"L","category":"architecture"}

{"id":"CT-7","location":"apps/caramel-app/src/app/api/sources/route.ts:15","quote":"successRate: number","what":"A field named successRate already exists, computed per scraper source (total_used / (total_used + total_expired)) and never persisted — a different metric, at a different grain, than a hypothetical per-store, attempt-based, persisted success rate.","why_it_matters":"The identical name increases the chance that a future implementer conflates the two metrics, extends the wrong one, or is misled while grepping the codebase for prior art on \"success rate.\"","severity":"Low","confidence":0.7,"fix_direction":"Rename one of the two fields (e.g. sourceHitRate vs. storeApplySuccessRate) so the name is unambiguous repo-wide.","effort":"S","category":"clarity"}

{"id":"CT-8","location":"apps/caramel-extension/background.js:1-275","quote":"currentBrowser.runtime.onMessage.addListener(\n (message, sender, sendResponse) => {\n if (!message || typeof message.action !== 'string') return","what":"background.js handles all outbound fetches (fetchCoupons, classifyCart, fetchSupportedStores) but never reads chrome.storage.sync — the token/user identity is read only by popup.js and written only by shared-utils.js's login listener.","why_it_matters":"Any feature requiring the checkout-page apply flow to act as the signed-in user (e.g. tagging a coupon-apply event with a user id) must newly teach background.js to read stored identity and branch guest-vs-logged-in, logic that today exists only inside popup.js's renderCouponsView.","severity":"Medium","confidence":0.85,"fix_direction":"Add one background.js message handler that reads storage.sync token once and attaches it to outbound requests, mirroring popup.js's guest/logged-in branch, instead of re-deriving this per feature.","effort":"M","category":"architecture"}

{"id":"CT-9","location":"apps/caramel-app/src/app/api/coupons/increment/route.ts:13-14","quote":"if (!isOriginAllowed(req)) return forbiddenOrigin()\nconst limited = await checkRateLimit(req, 'mutation')","what":"This exact origin-check + rate-limit pair is copy-pasted verbatim across three mutation routes (also apps/caramel-app/src/app/api/coupons/expire/route.ts:13 and apps/caramel-app/src/app/api/sources/route.ts:73-74) with no shared \"guarded mutation handler\" wrapper.","why_it_matters":"Every new mutation route (this audit needed two: apply-recording and attempt-reporting) copies this boilerplate a 4th and 5th time by hand; a future change to the guard logic (e.g. adding a new bypass condition) requires finding and editing every call site.","severity":"Low","confidence":0.9,"fix_direction":"Wrap the pair in a single higher-order function (e.g. withMutationGuard(handler)) that all mutation routes call.","effort":"S","category":"duplication"}
