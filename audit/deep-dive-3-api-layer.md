# DD-3: API Layer Deep Dive — apps/caramel-app/src/app/api/\*\*

caramel @ 537547b3081aa3a0ec817cdc5f6dac4f0d328dbb · read-only dive · exclusions.md honored

## Architecture sketch

17 route.ts files, Next.js 16 App Router. **No `middleware.ts` exists anywhere in the
repo** (confirmed by repo-wide glob) — every route hand-rolls its own gating inline.
Two data stores: Prisma/`DATABASE_URL` (users/sessions/accounts, owned by this app) and
a second Postgres pool via `couponsSql`/`COUPONS_DATABASE_URL` (coupon catalog, owned by
an external Python verification service — this app only reads it, plus 2 narrow
mutations: increment, expire). Auth is fragmented across 5 mechanisms: better-auth
sessions (real user login — never checked by any `api/**` route), a static
`EXTENSION_API_KEY` header (2 endpoints, 2 different comparison implementations), an
HMAC-signed short-lived state token (OAuth CSRF), a `UPKUMA_HEALTH_SECRET` bearer token,
and a hand-rolled Prisma-based session-issuance path inside `extension/oauth/route.ts`
that bypasses better-auth entirely. A full Pages-Router-era middleware/response/crypto
stack (7 files) survives as dead code, explicitly whitelisted in `knip.json`'s `ignore`
list rather than deleted. `rate-limiter-flexible` and a manual origin allowlist gate
mutation routes, applied inconsistently. Sentry is wired only via Next's automatic
`onRequestError` hook — no route calls it manually, and nearly every route catches its
own errors before they'd ever reach that hook.

## Convention counts

| Axis                                                | Count                   | Detail                                                                                                                                                                                           |
| --------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Route files in scope                                | 17                      | `middleware.ts`: **does not exist** anywhere in tracked source                                                                                                                                   |
| Body-parsing call sites                             | 9                       | 8× `req.json()`, 1× `req.formData()` (zero error handling)                                                                                                                                       |
| — swallow syntaxes for the same behavior            | 4                       | `.catch(()=>({}))` ×6, `.catch(()=>null)` ×1, bare `try{}catch{}` ×1, no catch ×1                                                                                                                |
| Schema-validation library used in api/\*\*          | 0                       | zod is not a dependency anywhere in the repo; `yup` is a dep but used only in one frontend signup form                                                                                           |
| Distinct success-envelope shapes                    | 5+                      | bare data object, `{status,message,data}` (nextApiResponse), raw DB-row passthrough, `{ok:true}`, bespoke `{token,username,image}`                                                               |
| Distinct error-envelope shapes                      | 2                       | `{error:string}` (16/17 routes) vs `{status:'error',message,data}` (sources only)                                                                                                                |
| Error-handling/logging styles                       | 4                       | console.error+500 (13 handlers), silent swallow+500 (2), no top-level catch (1), lib-internal catch→status object (1)                                                                            |
| Manual `Sentry.captureException` call sites         | 0                       | only automatic `onRequestError` hook exists; fires only on errors that escape a handler uncaught                                                                                                 |
| Distinct auth/gating mechanisms                     | 5                       | none/public, `EXTENSION_API_KEY` header, HMAC-signed state token, `UPKUMA_HEALTH_SECRET` bearer, `isOriginAllowed` allowlist                                                                     |
| `auth.api.getSession` calls inside api/\*\*         | 0                       | only referenced by dead `withAuth.ts`                                                                                                                                                            |
| Distinct CORS/origin-trust implementations          | 5                       | `isOriginAllowed` (rateLimit.ts), `isKnownExtensionOrigin` (oauth/authorize, duplicated 3× in-file), `getCorsHeaders` (oauth POST, different logic), dead `cors.ts` (hardcoded 3-site allowlist) |
| `process.env.*` names read in api/+lib              | ~26 unique              | 11 absent from `.env.example`, incl. one fail-fast-required (`COUPONS_DATABASE_URL`)                                                                                                             |
| Pages-Router fossil files (NextApiRequest/Response) | 7                       | all 7 paths listed in `knip.json`'s `ignore`; `cors` npm dep separately listed in `ignoreDependencies`                                                                                           |
| Handlers calling `checkRateLimit`                   | 11 of ~19               | absent from `extension/oauth` POST, `extension/login`, `sites/suggest`, both oauth GET routes                                                                                                    |
| Copy-pasted coupon-visibility SQL WHERE clause      | 5 occurrences / 4 files | + 2 narrower, divergent variants (filters, stats) = 3 competing "valid coupon" definitions                                                                                                       |

## Findings

```json
[
    {
        "id": "DD3-1",
        "location": "apps/caramel-app/src/app/api/coupons/expire/route.ts:15-19",
        "quote": "// server\nconst key = req.headers.get('x-api-key')\nconst expected = process.env.EXTENSION_API_KEY\nif (!expected || !key || key !== expected) {\n    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })\n}\n\n// client — apps/caramel-extension/background.js:23 (tracked in git, shipped to every install)\nconst EXTENSION_API_KEY = 'WXqEpm2uOV5jjJXPpnQFyZiNdaPVUrtd2LIrf4kc1JA'",
        "what": "The same static string is both (a) the server-side secret required by `x-api-key` to authorize `coupons/expire` — a POST that permanently sets `expired=TRUE` on arbitrary coupon rows, whose own code comment calls it 'Privileged... requires the extension/server API key... not just an origin check' — and (b) a hardcoded literal in the public extension's background script, sent as-is to production (`grabcaramel.com`) on every install. `rateLimit.ts`'s `isExtensionClient()` also treats this same value as a blanket exemption from all IP rate limiting.",
        "why_it_matters": "Anyone can extract this literal from the published extension (chrome://extensions source view, the .xpi/.crx, or this repo) and replay it directly against prod with a plain HTTP client — isOriginAllowed() returns true whenever the Origin header is absent, which is every non-browser request, so the origin check the comment leans on doesn't block this. The holder can mass-expire the coupon catalog while being simultaneously exempt from rate limiting.",
        "severity": "Critical",
        "confidence": 0.85,
        "verified": true,
        "survived_adversarial_review": null,
        "fix_direction": "Split the key: a low-privilege, rotatable key for read-only extension calls, and a separate never-shipped server/ops-only secret for mutation endpoints. A value that ships in a public client must never also gate a destructive one.",
        "effort": "M",
        "category": "security/dangerous-default"
    },
    {
        "id": "DD3-2",
        "location": "apps/caramel-app/src/app/api/coupons/expire/route.ts:17",
        "quote": "// supported-stores/route.ts:14-19 (read-only endpoint) — constant-time\nlet mismatch = 0\nfor (let i = 0; i < header.length; i++) {\n    mismatch |= header.charCodeAt(i) ^ EXTENSION_API_KEY.charCodeAt(i)\n}\nreturn mismatch === 0\n\n// coupons/expire/route.ts:17 (mutating endpoint) — naive\nif (!expected || !key || key !== expected) {",
        "what": "The read-only supported-stores route compares the API key in constant time specifically 'to avoid timing-based key probing' per its own comment. The mutating coupons/expire route, gated by the identical env var, compares with plain !==, which short-circuits on the first mismatched byte.",
        "why_it_matters": "The team clearly knows timing-safe comparison matters for this exact secret — they wrote it once — but applied it to the lower-stakes endpoint and skipped it on the higher-stakes one. The protection is backwards relative to what each endpoint can do.",
        "severity": "Medium",
        "confidence": 0.9,
        "verified": true,
        "survived_adversarial_review": null,
        "fix_direction": "Extract one validateExtensionApiKey(req) helper (constant-time) and use it at every EXTENSION_API_KEY check site instead of two independently-written comparisons.",
        "effort": "S",
        "category": "security/inconsistency"
    },
    {
        "id": "DD3-3",
        "location": "apps/caramel-app/src/app/api/classify-cart/route.ts:67 (+8 more — see what)",
        "quote": "sites/suggest/route.ts:5        (await req.json().catch(() => ({}))) as {...}\nextension/login/route.ts:5      (await req.json().catch(() => ({}))) as {...}\nextension/oauth/route.ts:83     (await req.json().catch(() => ({}))) as {...}\nclassify-cart/route.ts:67       await req.json().catch(() => null)\ncoupons/increment/route.ts:20   (await req.json().catch(() => ({}))) as {...}\ncoupons/expire/route.ts:24      (await req.json().catch(() => ({}))) as {...}\nsources/route.ts:78             (await req.json().catch(() => ({}))) as {...}\nsites/search-supported/route.ts:13-15  try { body = await req.json() } catch {}\nextension/oauth/redirect/route.ts:15   await req.formData()  // no .catch at all",
        "what": "All 9 body-parsing call sites in the API layer treat a malformed request body as equivalent to an absent one, using 4 different syntaxes for the same swallow. No route distinguishes 'malformed JSON' from 'valid JSON missing a field' — both fall through to the same generic 400 or a silent default. Zero routes validate with a schema library: zod is not a dependency anywhere in the repo; yup is a dependency but used only in one frontend signup form, never in api/**.",
        "why_it_matters": "This is one root cause with 9 symptoms. A client bug that sends truncated/invalid JSON is silently indistinguishable from a request that validly omitted the field, in both the response and the logs. Every route hand-rolls its own ad-hoc field checks instead of sharing one validated-input pattern.",
        "severity": "High",
        "confidence": 0.95,
        "verified": true,
        "survived_adversarial_review": null,
        "fix_direction": "Add zod, define one schema per route body, parse once via a shared helper (schema.safeParse(await req.json().catch(() => null))), and return a structured 400 with validation errors on failure.",
        "effort": "M",
        "category": "maintainability/convention-drift"
    },
    {
        "id": "DD3-4",
        "location": "apps/caramel-app/src/app/api/extension/oauth/authorize/route.ts:52",
        "quote": "const provider = searchParams.get('provider') as 'google' | 'apple' | null\nconst redirectUri = searchParams.get('redirect_uri')\n...\nif (provider !== 'google' && provider !== 'apple') {\n    return NextResponse.json(\n        { error: 'Invalid provider. Must be \"google\" or \"apple\"' },",
        "what": "Confirms the nomination: the raw query param is cast to the literal union type before any check. Refutes the security framing though — 26 lines later (line 78) the value is validated against the same two literals before it's used anywhere, so an arbitrary string never reaches the Google/Apple branches unchecked. The identical cast-then-validate shape also appears in extension/oauth/route.ts for the POST body's provider field.",
        "why_it_matters": "Not exploitable as written, but the pattern asserts a type the runtime hasn't earned yet — exactly the failure mode schema validation exists to prevent. A future edit that moves the cast's usage earlier, or copies this shape into a route that forgets the check, has no compiler protection against it.",
        "severity": "Low",
        "confidence": 0.9,
        "verified": true,
        "survived_adversarial_review": null,
        "fix_direction": "Replace the cast with a real narrowing check (if (provider === 'google' || provider === 'apple')) or a small zod enum, so the type only exists once it's actually verified.",
        "effort": "S",
        "category": "clarity/type-safety"
    },
    {
        "id": "DD3-5",
        "location": "apps/caramel-app/src/app/api/sources/route.ts:65",
        "quote": "// coupons/route.ts:111-112 (bare data object)\nreturn NextResponse.json({ coupons, page, limit, total, hasMore }, {...})\n\n// sources/route.ts:65 (nextApiResponse envelope)\nreturn nextApiResponse(req, 200, 'sources', sourcesWithMetrics)\n// -> { status: 'success', message: 'sources', data: sourcesWithMetrics }\n\n// coupons/increment/route.ts:48 (raw DB row, no envelope)\nreturn NextResponse.json(rows[0])\n\n// sites/suggest/route.ts:17 (bare boolean flag)\nreturn NextResponse.json({ ok: true })",
        "what": "Counted across the 17 routes: at least 5 distinct success-envelope shapes and 2 distinct error shapes (`{error:string}` used by 16/17 routes vs sources/route.ts's `{status:'error',message,data:null}`). sources/route.ts is the only route importing @/lib/apiResponseNext at all.",
        "why_it_matters": "No client can code against a single contract. The extension compensates by defensively checking r.ok and hardcoding per-endpoint fallbacks (`{coupons:[]}`, `{supported:[]}` in background.js) rather than trusting a shared shape. The inconsistency is pure drift: nothing enforces the nextApiResponse convention outside the one file that happens to use it.",
        "severity": "Medium",
        "confidence": 0.9,
        "verified": true,
        "survived_adversarial_review": null,
        "fix_direction": "Pick the shape 16/17 routes already converged on (bare data on 200, {error} on failure), migrate sources/route.ts to match, then delete apiResponseNext.ts.",
        "effort": "S",
        "category": "maintainability/convention-drift"
    },
    {
        "id": "DD3-6",
        "location": "apps/caramel-app/src/app/api/coupons/route.ts:48 (+4 more — see what)",
        "quote": "status IN ('valid','valid_with_warning','product_restriction','category_restricted','seller_specific','pending','retry') AND expired = FALSE\n\n// coupons/filters/route.ts:20 (narrower)\nWHERE status = 'valid' AND expired = FALSE AND site IS NOT NULL\n\n// coupons/stats/route.ts:15 (narrowest — no expired filter at all)\nWHERE status = 'valid'",
        "what": "The 7-status 'visible coupon' whitelist is copy-pasted verbatim 5 times across 4 files: coupons/route.ts:48, coupons/stores/route.ts:18 and :25, sites/top-sites/route.ts:13, sites/search-supported/route.ts:24-25. Two more files implement different, narrower definitions: coupons/filters uses only status='valid', and coupons/stats uses only status='valid' with no expired filter at all.",
        "why_it_matters": "Three competing definitions of 'live coupon' exist in one small API surface. Concretely: /api/coupons/stats's total/active counts only ever count status='valid' rows, while the actual browsable listing (/api/coupons) also surfaces valid_with_warning, pending, retry, etc. — so any UI showing the stats figure undercounts what users can actually browse. If the status taxonomy changes, 5 copies must change in lockstep or the endpoints silently diverge further.",
        "severity": "High",
        "confidence": 0.85,
        "verified": true,
        "survived_adversarial_review": null,
        "fix_direction": "Extract the visibility predicate into one shared couponsSql fragment/constant imported by every route that needs it; make a deliberate, documented call on whether /stats should use the same definition.",
        "effort": "S",
        "category": "maintainability/dedup"
    },
    {
        "id": "DD3-7",
        "location": "apps/caramel-app/src/lib/middlewares/withAuth.ts:1",
        "quote": "// knip.json\n\"ignore\": [\n  \"src/lib/cors.ts\",\n  \"src/lib/initMiddleware.ts\",\n  \"src/lib/middlewares/**\",\n  \"src/lib/securityHelpers/apiResponse.ts\",\n  ...\n],\n\"ignoreDependencies\": [ ..., \"cors\", ... ]",
        "what": "6 files still import NextApiRequest/NextApiResponse from 'next' (Pages Router types) though every live route is an App Router route.ts: initMiddleware.ts, cors.ts, middlewares/withAuth.ts, middlewares/withRoles.ts, middlewares/errorMiddleware.ts, securityHelpers/apiResponse.ts. Grepping the whole app for their exports (withAuth(, withRoles(, cors import, onErrorMiddleware, apiResponse() turns up zero callers outside their own definitions. Instead of deleting them, every one of these paths — plus the now-pointless cors npm dependency they exist to wrap — is listed in knip's ignore/ignoreDependencies, permanently silencing the dead-code linter rather than resolving what it flagged.",
        "why_it_matters": "This is confirmed dead weight, not a judgment call — knip already flagged it and the team suppressed the flag. It includes a hand-rolled Pages-Router auth gate (withAuth.ts) that a future engineer searching for 'how do we gate a route with auth' may find and mistake for the pattern to follow; it silently does nothing against an App Router route.ts.",
        "severity": "High",
        "confidence": 0.95,
        "verified": true,
        "survived_adversarial_review": null,
        "fix_direction": "Delete all 6 files (keep only the live client-side half of cryptoHelpers.ts, see DD3-8), remove the cors/@types/cors dependencies, and remove the corresponding knip ignore entries.",
        "effort": "S",
        "category": "maintainability/dead-code"
    },
    {
        "id": "DD3-8",
        "location": "apps/caramel-app/src/lib/securityHelpers/cryptoHelpers.ts:63-75",
        "quote": "export function encryptJsonServer(req: NextApiRequest, payload: any): string {\n    const domain = (req.headers.host || '').replace(/:\\d+$/, '')\n    const userAgent = req.headers['user-agent'] || ''\n    const key = domain + userAgent\n    ...\n}\n// apiResponseNext.ts:46 — server flag\nif (process.env.API_ENCRYPTION_ENABLED !== 'true') { ... }\n// decryptJsonData.ts:5 — separately-named client flag\nif (process.env.NEXT_PUBLIC_API_ENCRYPTION_ENABLED !== 'true') { ... }",
        "what": "A home-rolled XOR cipher 'encrypts' JSON responses using a key built from the Host and User-Agent headers — both fully attacker-known or attacker-chosen, so the key provides no confidentiality to anyone who can also read the response over the wire. It's wired to /api/sources (public, unauthenticated GET of business metrics) via apiResponseNext.ts, gated by API_ENCRYPTION_ENABLED server-side and a separately-named NEXT_PUBLIC_API_ENCRYPTION_ENABLED client-side that must be manually kept in sync.",
        "why_it_matters": "Dormant by default (both flags default off; neither name appears in any tracked env/config file), so no live exploitation found. But it's a landmine: flipping API_ENCRYPTION_ENABLED=true believing it adds protection yields a trivially reversible cipher over non-secret headers, plus real risk of a working-server/broken-client incident from the flag-name mismatch.",
        "severity": "Medium",
        "confidence": 0.85,
        "verified": true,
        "survived_adversarial_review": null,
        "fix_direction": "Delete the encryption path entirely rather than fix it — TLS already protects transport and /api/sources has no confidentiality requirement to begin with.",
        "effort": "S",
        "category": "security/dead-code"
    },
    {
        "id": "DD3-9",
        "location": "apps/caramel-app/src/app/api/extension/oauth/authorize/route.ts:36-48,56-67,199-208",
        "quote": "// OPTIONS handler, lines 42-44\nheaders.set('Access-Control-Allow-Origin', origin)\nheaders.set('Access-Control-Allow-Methods', 'GET, OPTIONS')\nheaders.set('Access-Control-Allow-Headers', 'Content-Type')\n\n// catch block, lines 199-207 -- comment admits it's a copy\n// Re-create CORS headers in catch block\nconst headers = new Headers()\nconst origin = req.headers.get('origin')\nconst isExtensionOrigin = isKnownExtensionOrigin(origin)\nif (isExtensionOrigin && origin) {\n    headers.set('Access-Control-Allow-Origin', origin)\n    ...",
        "what": "The identical 3-line CORS-header block is written by hand 3 times in this one file: the OPTIONS handler, the getCorsHeaders() closure defined to hold this logic, and again inline in the catch block (whose own comment says 'Re-create CORS headers in catch block' rather than simply calling the in-scope getCorsHeaders()). Separately, extension/oauth/route.ts (the POST that exchanges the code) implements its own getCorsHeaders(req) trusting any origin starting with chrome-extension://, moz-extension://, or safari-web-extension://, vs. this file's exact-match allowlist against CHROME_EXTENSION_ORIGIN/FIREFOX_EXTENSION_ORIGIN/SAFARI_EXTENSION_ORIGIN. Counting rateLimit.ts's isOriginAllowed() and the dead cors.ts, 5 independent 'is this origin trusted' implementations exist live or fossil in this codebase.",
        "why_it_matters": "The code-exchange endpoint (POST, mints sessions) accepts CORS from any extension ID; the authorize endpoint (GET, only returns a URL) restricts to specific known origins -- the same inversion-of-caution as DD3-2. The in-file triplication means a future CORS policy change has to be remembered in 3 places in one file alone.",
        "severity": "High",
        "confidence": 0.9,
        "verified": true,
        "survived_adversarial_review": null,
        "fix_direction": "Extract one shared extensionCorsHeaders(req) helper used by both oauth files, decide once whether extension-origin trust is allowlist- or protocol-based, and always call the helper instead of inlining.",
        "effort": "M",
        "category": "maintainability/dedup"
    },
    {
        "id": "DD3-10",
        "location": "apps/caramel-app/src/app/api/extension/oauth/route.ts:81",
        "quote": "// extension/oauth/route.ts:81-90 -- no checkRateLimit anywhere in this file\nexport async function POST(req: NextRequest) {\n    const corsHeaders = getCorsHeaders(req)\n    const body = (await req.json().catch(() => ({}))) as {...}\n\n// sites/suggest/route.ts:4-17 -- no rate limit, no origin/auth check\nexport async function POST(req: NextRequest) {\n    const { url = '' } = (await req.json().catch(() => ({}))) as {...}\n    ...\n    await sendEmail({ to: 'support@unotes.net', ... })",
        "what": "checkRateLimit is applied in 11 handlers across 8 files but is absent from: extension/oauth POST (creates/updates Prisma User/Account/Session rows and calls Google/Apple's token endpoints per request), extension/login POST, both extension/oauth/authorize and extension/oauth/redirect, and sites/suggest POST -- which additionally has no auth and no isOriginAllowed check at all.",
        "why_it_matters": "sites/suggest is a fully public, unauthenticated endpoint whose only effect is a real outbound sendEmail() to the team's support inbox -- nothing stops a script from looping it. extension/oauth POST is the single most side-effect-heavy unauthenticated route in the app (external HTTP calls plus 3+ DB writes per request) and is exactly what the app's own 'mutation' rate-limit tier (30/min/IP) was designed for, yet it isn't wired in.",
        "severity": "High",
        "confidence": 0.9,
        "verified": true,
        "survived_adversarial_review": null,
        "fix_direction": "Add checkRateLimit(req, 'mutation') to extension/oauth POST and sites/suggest POST at minimum; treat every route that writes or sends as rate-limited by default, not opt-in.",
        "effort": "S",
        "category": "operability/rate-limiting"
    },
    {
        "id": "DD3-11",
        "location": "apps/caramel-app/src/app/api/sites/suggest/route.ts:18-23",
        "quote": "// sites/suggest/route.ts:18-23 -- fully silent\n} catch {\n    return NextResponse.json(\n        { error: 'Could not save suggestion' },\n        { status: 500 },\n    )\n}\n\n// instrumentation.ts:12 -- Sentry's ONLY route-error wiring\nexport const onRequestError = Sentry.captureRequestError",
        "what": "4 distinct error-handling styles across the 17 routes: (1) console.error then a 500 JSON -- 13 handlers; (2) fully silent catch, no log at all -- sites/suggest and extension/login (also confirms the extension/oauth/redirect nomination: that file has zero console.* calls anywhere, though unlike the other two it also has no top-level try/catch, so a genuine bug there would actually surface); (3) no top-level catch, letting unexpected errors bubble to Next.js -- extension/oauth/redirect; (4) library-internal catch converting failure to a status object with no logging -- lib/health.ts's timedCheck. Zero of the 17 routes call Sentry.captureException or any other Sentry API directly -- the only Sentry wiring anywhere in the app is the automatic onRequestError hook.",
        "why_it_matters": "onRequestError only fires for errors that escape a route handler uncaught. Since every route except oauth/redirect wraps its own logic in try/catch and returns a JSON 500 instead of rethrowing, the handled errors -- DB failures, OpenRouter timeouts, OAuth token-exchange failures, the ones an operator actually needs visibility into -- structurally never reach Sentry. In production, Sentry for this API surface is close to a no-op; the only record of most failures is a console line that may or may not be aggregated anywhere.",
        "severity": "High",
        "confidence": 0.9,
        "verified": true,
        "survived_adversarial_review": null,
        "fix_direction": "Add Sentry.captureException(error) inside a shared error-handling helper (pairs naturally with the envelope fix in DD3-5) instead of relying on the automatic hook; keep console.error for local dev only.",
        "effort": "M",
        "category": "operability/observability"
    },
    {
        "id": "DD3-12",
        "location": "apps/caramel-app/middleware.ts (does not exist)",
        "quote": "(no file -- confirmed via repo-wide glob for middleware.ts / middleware.tsx: zero matches outside node_modules)",
        "what": "There is no Next.js middleware.ts anywhere in the repo. Every route re-implements its own auth/origin/rate-limit gating inline as the first 1-3 lines of the handler (if (!isOriginAllowed(req)) return forbiddenOrigin(); const limited = await checkRateLimit(req, ...); if (limited) return limited), copy-pasted across the 8 files that have it at all (and absent from others, see DD3-10).",
        "why_it_matters": "Centralizing origin/rate-limit gating in middleware.ts -- Next.js's purpose-built mechanism for exactly this -- would make 'every mutation is rate-limited and origin-checked' a structural guarantee instead of a convention every new route author must remember to copy correctly, which is precisely how extension/oauth and sites/suggest ended up ungated (DD3-10).",
        "severity": "Medium",
        "confidence": 0.9,
        "verified": true,
        "survived_adversarial_review": null,
        "fix_direction": "Move the origin-allowlist + rate-limit-tier decision into middleware.ts, keyed on path prefix, so new routes inherit it by default instead of opting in.",
        "effort": "M",
        "category": "maintainability/architecture"
    },
    {
        "id": "DD3-13",
        "location": "apps/caramel-app/src/app/api/extension/oauth/route.ts:226-297",
        "quote": "user = await prisma.user.create({\n    data: {\n        email: userEmail,\n        ...\n        emailVerified: googleUser.verified_email || false,\n        status: googleUser.verified_email ? 'ACTIVE_USER' : 'NOT_VERIFIED',\n    },\n})\n...\nconst sessionToken = randomBytes(32).toString('base64url')\nconst session = await prisma.session.create({\n    data: { token: sessionToken, userId: user.id, expiresAt },\n})",
        "what": "This route creates User, Account, and Session rows directly via Prisma and mints its own session token with randomBytes, bypassing better-auth's own sign-up/session APIs entirely (the ones auth/[...all]/route.ts and extension/login/route.ts use). Grepping the file confirms emailVerified/status are only ever written here, never read/checked before minting a token -- unlike extension/login's email/password path, which surfaces better-auth's EMAIL_NOT_VERIFIED check and blocks unverified accounts. Both the Google and Apple branches (mirrored at :468-544) mint a working session even when verified_email is false and the user row is stamped status:'NOT_VERIFIED'.",
        "why_it_matters": "Two independent, hand-written implementations of 'what it means to be signed in' now have to be kept semantically consistent by hand -- and already aren't: one enforces email verification before issuing a session, the other doesn't. Any future change to better-auth's session model (hashing, rotation, additional claims) has to be manually ported here or silently drifts out of sync.",
        "severity": "Medium",
        "confidence": 0.8,
        "verified": true,
        "survived_adversarial_review": null,
        "fix_direction": "Route through better-auth's own social sign-in completion instead of writing to Session/Account/User directly; if that's not feasible for the extension flow, at minimum gate on emailVerified before returning a usable token, matching the email/password path.",
        "effort": "L",
        "category": "maintainability/architecture"
    },
    {
        "id": "DD3-14",
        "location": "apps/caramel-app/.env.example",
        "quote": "// couponsDb.ts:9-12 -- fails fast if unset\nconst connectionString = process.env.COUPONS_DATABASE_URL\nif (!connectionString) {\n    throw new Error('COUPONS_DATABASE_URL is not set')\n}\n// .env.example has DATABASE_URL but no COUPONS_DATABASE_URL entry at all",
        "what": "Of ~26 distinct process.env.* names read across the API routes and shared lib, at least 11 are absent from .env.example: EXTENSION_API_KEY, EXTENSION_OAUTH_STATE_SECRET, COUPONS_DATABASE_URL, CHROME_EXTENSION_ORIGIN, FIREFOX_EXTENSION_ORIGIN, SAFARI_EXTENSION_ORIGIN, ALLOWED_ORIGINS, UPKUMA_HEALTH_SECRET, API_ENCRYPTION_ENABLED, NEXT_PUBLIC_API_ENCRYPTION_ENABLED, NEXT_PUBLIC_GOOGLE_ANALYTICS_ID. COUPONS_DATABASE_URL is not optional -- the module throws at import time without it. No env var anywhere is validated by zod or any schema.",
        "why_it_matters": ".env.example is the app's only self-documentation of its configuration surface, and it postdates both the extension-auth work and the 'DB split' couponsDb.ts's own comment describes -- a new environment bootstrapped from it alone crashes immediately on the missing COUPONS_DATABASE_URL, with the real required name discoverable only by reading source.",
        "severity": "Medium",
        "confidence": 0.85,
        "verified": true,
        "survived_adversarial_review": null,
        "fix_direction": "Regenerate .env.example from an actual inventory of process.env reads, or introduce one zod-validated env module every route/lib imports from instead of raw process.env, so missing vars fail at boot with a clear message.",
        "effort": "S",
        "category": "operability/config"
    },
    {
        "id": "DD3-15",
        "location": "apps/caramel-app/src/app/api/coupons/stores/route.ts",
        "quote": "GET /api/coupons/stores?q=...      -> { sites: [...] }   (query-string input)\nPOST /api/sites/search-supported    -> { sites: [...] }   (JSON-body input, same conceptual search)\nGET /api/sites/top-sites            -> { sites: [...] }   (top 4 by coupon count, no input)\nGET /api/coupons/filters            -> { sites: [...], discountTypes: [...] }\nGET /api/extension/supported-stores -> { supported: [...] }  (xpath automation configs -- unrelated meaning of \"supported\")",
        "what": "Four separate endpoints return a list of site/store names for what is functionally the same underlying concept (distinct sites with visible coupons), split across two path prefixes (/api/coupons/*, /api/sites/*) with no naming rule distinguishing them. The two search-shaped ones (coupons/stores, sites/search-supported) take their query via different transports -- URL query param vs. JSON body -- for the same kind of request. extension/supported-stores reuses the word 'supported' for a third, unrelated meaning, one path segment away from sites/search-supported.",
        "why_it_matters": "A reader trying to find 'the endpoint that searches sites' has 2 real candidates and 1 false-friend (supported-stores) to disambiguate by reading source, not by name. No convention exists for where a new 'sites matching X' endpoint should live or how it should take input.",
        "severity": "Medium",
        "confidence": 0.75,
        "verified": true,
        "survived_adversarial_review": null,
        "fix_direction": "Consolidate under one /api/sites resource with consistent GET+query-param semantics, and rename extension/supported-stores to something unambiguous like extension/automation-configs.",
        "effort": "M",
        "category": "clarity/naming"
    }
]
```
