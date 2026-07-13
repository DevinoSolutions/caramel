# DD-1 — AI surface deep dive (classify-cart / openrouter / extension consumers)

Baseline: dev @ 537547b3081aa3a0ec817cdc5f6dac4f0d328dbb. Rules graded against shared-claude-rules.md **v5** §"AI quality (evals)" (read from the file).

## Surface sketch

The repo has exactly ONE LLM surface. Flow:

1. Extension `shared-utils.js getCoupons()` — only when a returned coupon carries a `RESTRICTED_STATUSES` status — calls `classifyCartCategory()`.
2. `cart-signals.js collectCartSignals()` scrapes `{domain, url_path, title, meta_description, og_site_name, og_type, cart_items≤6, platform_hints}` from the shop page (Shopify `/cart.js` probe → DOM selectors → JSON-LD fallback).
3. `background.js` relays runtime message `'classifyCart'` → `POST {BASE}/api/classify-cart` (Content-Type only — no api key, 8s timeout).
4. `route.ts`: origin allow-list → `checkRateLimit(req,'mutation')` (30/min/IP; EXTENSION_API_KEY holders fully exempt) → client-declared content-length check (8KB) → `req.json().catch(()=>null)` → hand-rolled `sanitize()` → `classifyCart()`.
5. `cartClassifier.ts`: sha256 cache key (domain/title/meta/items; 2000-entry in-memory LRU, 24h TTL) → `buildMessages()` (system prompt + JSON of domain/title/meta/site_name/items) → `openrouter.chat()` (`OPENROUTER_MODEL || 'openai/gpt-5-mini'`, temp 0, max_tokens 120, json_object, 7s abort) → `parseResponse()` validates `primary` against `CATEGORY_ENUM`, silently coerces `secondary`/`confidence`.
6. `{primary, secondary?, confidence, cached}` → extension annotates restricted coupons with `cartCategory` → `popup.js` renders "your cart looks like **{token}**".

`openrouter.chat()` has exactly one consumer (cartClassifier); `/api/classify-cart` has exactly one caller (extension background) — no app-side consumer. Naming is honest (`classify-cart`/`classifyCart`/`cartClassifier`/`chat`); Stage-0 name-only navigation logged `openrouter.chat` as a HIT — a light model lands here correctly.
Eval story: none. No `*.eval.*` files, no `evals/` dir, no scorers, no eval workflow (`.github/workflows` = checks-app.yml, checks-extension.yml, release-extension.yml), and the app package.json has no test script of any kind. `scripts/test-cart-signals.mjs` exercises only the DOM extractor, never the model.
Failure UX: any LLM error → 502/500 JSON → extension converts to a silent `null` (restricted coupons just lose their hint); Sentry receives nothing (the route catches before `onRequestError` can fire; `console.error` only).

## FINDINGS

```json
[
    {
        "id": "DD1-1",
        "location": "apps/caramel-app/src/lib/cartClassifier.ts:93-108 (prompt); apps/caramel-app/src/lib/openrouter.ts:2; apps/caramel-app/.env.example:24-25; .github/workflows/* (absence)",
        "quote": "cartClassifier.ts:97-99: 'You classify e-commerce carts into a category so the app can show relevant coupons. ' +\n    'You get a compact JSON snapshot of the shop and cart. ' +\n    `Return JSON ONLY, schema: {\"primary\":\"<one_of>\",\"secondary\":\"<one_of_or_null>\",\"confidence\":0..1}. ` +\nopenrouter.ts:2: const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-5-mini'\n.env.example:24-25: OPENROUTER_API_KEY=\nOPENROUTER_MODEL=openai/gpt-5-mini",
        "what": "The repo's only user-facing LLM surface (cart classification feeding the popup's restriction warnings) has zero eval coverage: glob finds no *.eval.* files, no evals/ directory, no scorers; .github/workflows contains only checks-app.yml, checks-extension.yml, release-extension.yml (no ai-evals workflow, no nightly, no dispatch); no scoreboard exists; the app package.json has no test script at all. The production prompt and CATEGORY_ENUM live only in cartClassifier.ts, so there is no import-vs-copy question — there is nothing that consumes them. The model is pinned in two places — code default 'openai/gpt-5-mini' and the OPENROUTER_MODEL env override, pre-filled with the same value in .env.example — with no audit that they agree at deploy time.",
        "why_it_matters": "Grades as a miss on every bullet of shared-claude-rules v5 §'AI quality (evals)': no fixed-dataset suite against the live model+prompts, no CI gate (PR path-filtered / nightly with auto-issue / manual dispatch), so a provider silently changing gpt-5-mini degrades classification with zero code change and nothing catches it; model swaps cannot be eval-gated (no suite to gate with); no regression proof; and a stale OPENROUTER_MODEL host pin would silently override the code default with nothing checking. Misclassification directly mislabels the 'your cart looks like X' warning users act on beside restricted coupons.",
        "severity": "High",
        "confidence": 0.95,
        "verified": true,
        "survived_adversarial_review": null,
        "fix_direction": "Run /ai-evals: fixed dataset of real cart-signal payloads -> suite imports buildMessages/parseResponse/CATEGORY_ENUM from cartClassifier.ts (never copies) -> deterministic scorers (valid JSON, enum membership, expected primary per case, confidence bounds) -> ai-evals.yml path-filtered to classify-cart/cartClassifier/openrouter, plus nightly with auto-opened issue and manual dispatch; verify CI secret exists via gh secret list; add the OPENROUTER_MODEL-pin-vs-code-default audit to the model-swap checklist.",
        "effort": "L",
        "category": "ai-quality/missing-evals"
    },
    {
        "id": "DD1-2",
        "location": "apps/caramel-app/src/app/api/classify-cart/route.ts:67,80-92; apps/caramel-app/src/instrumentation.ts:12; apps/caramel-extension/background.js:166-167; apps/caramel-extension/shared-utils.js:1066-1089",
        "quote": "route.ts:80-82:    } catch (error) {\n        const status = error instanceof OpenRouterError ? 502 : 500\n        console.error('[classify-cart] failed', error)\nroute.ts:67:    const raw = await req.json().catch(() => null)\ninstrumentation.ts:12: export const onRequestError = Sentry.captureRequestError\nbackground.js:167:                .then(async r => {\n                    if (!r.ok) return { error: `HTTP ${r.status}` }\nshared-utils.js:1072:        if (result && result.primary && !result.error) {\nshared-utils.js:1089:    return null",
        "what": "Every failure path on this surface is shaped into a response and never into telemetry — one root flaw with instances on both sides. Server: the route catches all classification errors and responds 502/500 with only console.error; Sentry's onRequestError (the sole server error hook) fires only for errors that escape the handler, so a caught 'model broke' never creates a Sentry event; malformed JSON is swallowed to null (req.json().catch) and merged with shape-invalid input into a single unlogged 400 — parse failure and contract failure are indistinguishable and leave no server-side trace. Extension: background converts any non-OK status to {error:'HTTP n'} without logging; classifyCartCategory sees result.error, fails its `result.primary && !result.error` guard, and returns null with no log (its catch/log fires only on thrown exceptions; the runtime.sendMessage callback also never checks runtime.lastError). A server 502 therefore produces zero log lines end to end. Quota exhaustion (OpenRouter 429/402, carried in OpenRouterError.status) is collapsed into the same 502 as an outage.",
        "why_it_matters": "v5 'Errors & visibility': 'No silent failures … Errors throw loudly with Sentry-usable context.' On-call cannot tell 'model broke' from 'extension broke' — neither side reports to anything queryable; the only artifact is a stdout line in the Dokploy container log. The user experience is a silently missing cart-category hint, so a total classifier outage (bad key, quota gone, provider down) can persist indefinitely with no signal anywhere.",
        "severity": "High",
        "confidence": 0.9,
        "verified": true,
        "survived_adversarial_review": null,
        "fix_direction": "Route catch: Sentry.captureException(error, {tags:{surface:'classify-cart', provider_status:(error as OpenRouterError).status}}) before responding; log the JSON-parse branch and the sanitize-reject branch as distinct warnings. Extension: log non-OK responses in background's classifyCart handler and check runtime.lastError in classifyCartCategory. Keep 502 vs 500, and surface OpenRouterError.status (429/402 vs 5xx) as a tag so quota exhaustion is distinguishable.",
        "effort": "M",
        "category": "operability/error-visibility"
    },
    {
        "id": "DD1-3",
        "location": "apps/caramel-app/src/lib/cartClassifier.ts:85-91 (drop point); apps/caramel-app/src/app/api/classify-cart/route.ts:32,36,38-50; apps/caramel-extension/cart-signals.js:148,154,156-170",
        "quote": "cartClassifier.ts:85-91:    const payload = {\n        domain: s.domain,\n        title: s.title || '',\n        meta_description: s.meta_description || '',\n        site_name: s.og_site_name || '',\n        cart_items: (s.cart_items || []).slice(0, 6),\n    }\nroute.ts:38-43:        platform_hints:\n            b.platform_hints && typeof b.platform_hints === 'object'\n                ? (Object.fromEntries(\n                      (\n                          Object.entries(\n                              b.platform_hints as Record<string, unknown>,\ncart-signals.js:156-157:            platform_hints: {\n                shopify: !!(",
        "what": "Three fields ride the full wire contract and are dropped before the model ever sees them: url_path, og_type, and platform_hints are scraped by cart-signals.js (~15 lines of Shopify/Woo/BigCommerce/Magento detection), transmitted, and laundered by the route's most convoluted sanitize block (the 13-line platform_hints cast pyramid, route.ts:38-50) — yet buildMessages' payload contains only domain/title/meta_description/site_name/cart_items. The contract is ragged elsewhere too: og_site_name is in the prompt but excluded from cacheKey (cartClassifier.ts:50-55 keys only d/t/m/i, so carts differing only by site_name share a cache entry), and the extension self-caps meta_description at 300 / url_path at 120 while sanitize allows 400/200.",
        "why_it_matters": "This is v5's 'no trial-and-error layering' defect in contract form: dead branches left from iteration. A next agent reading sanitize() or the platform-detection code will reasonably assume platform/url signals influence classification — they don't — and every future edit pays to maintain, cap, and sanitize fields that terminate in /dev/null. The heaviest type-gymnastics in the route exist solely to validate unused data.",
        "severity": "Medium",
        "confidence": 0.95,
        "verified": true,
        "survived_adversarial_review": null,
        "fix_direction": "Per field, decide: feed it to the prompt (platform_hints is a genuinely useful classification signal; url_path distinguishes /cart from /product pages) or delete it end-to-end (collector, wire payload, sanitize, CartSignals type). Align remaining caps extension-side == route-side, and either add og_site_name to cacheKey or drop it from the prompt.",
        "effort": "S",
        "category": "maintainability/dead-contract"
    },
    {
        "id": "DD1-4",
        "location": "apps/caramel-app/src/app/api/classify-cart/route.ts:15,26,43-49; apps/caramel-app/src/lib/cartClassifier.ts:119-123,125,132-133,142,166; apps/caramel-app/src/lib/openrouter.ts:64-66",
        "quote": "route.ts:15:    const b = body as Record<string, unknown>\nroute.ts:43-49:                              b.platform_hints as Record<string, unknown>,\n                          ).filter(([, v]) => typeof v === 'boolean') as [\n                              string,\n                              boolean,\n                          ][]\n                      ).slice(0, 10),\n                  ) as Record<string, boolean>)\ncartClassifier.ts:119-123:    const obj = parsed as {\n        primary?: string\n        secondary?: string | null\n        confidence?: number\n    }\ncartClassifier.ts:142:        primary: primary as Category,\nopenrouter.ts:64:        const json = (await res.json()) as {",
        "what": "Both edges of the LLM boundary are typed by assertion instead of validation — one root flaw, a dozen-plus `as` casts across three files: sanitize() is ~40 lines of hand-rolled narrowing with 5 casts (route.ts:15,26,43,44-47,49 including the [string,boolean][] pyramid); parseResponse() casts the model's JSON to an anonymous inline shape then re-casts fields (parsed as {...}; CATEGORY_ENUM as readonly string[] twice at :125/:132; secondary as Category :133; primary as Category :142; plus (e as Error) :166); openrouter.ts casts the provider envelope (:64). There is no schema library at all — zod appears nowhere in the app's dependencies or imports — although v5 mandates zod-validated env and one shared producer/consumer contract.",
        "why_it_matters": "v5 'Typing & contracts': 'Producer and consumer share one schema … drift fails statically or in CI, never only at runtime.' Today the extension payload, sanitize()'s narrowing, the CartSignals interface, and the model-output shape are four independently hand-maintained artifacts; drift (DD1-3 is the live proof) compiles clean and misbehaves only at runtime. Each cast is a spot a future agent can silently widen. One honest schema pair (CartSignalsSchema in, ClassificationSchema out) collapses sanitize(), parseResponse(), and the envelope cast into declarative code.",
        "severity": "Medium",
        "confidence": 0.9,
        "verified": true,
        "survived_adversarial_review": null,
        "fix_direction": "Add zod: CartSignalsSchema (z.string().max caps replacing the str()/arr() helpers; z.record(z.boolean()) for platform_hints) and ClassificationSchema (primary: z.enum(CATEGORY_ENUM), confidence: z.number().min(0).max(1)). sanitize() becomes CartSignalsSchema.safeParse; parseResponse() becomes ClassificationSchema.parse; give the OpenRouter envelope a minimal schema. Derive all types via z.infer; the casts fall away. Same schemas become the eval suite's imports (DD1-1).",
        "effort": "M",
        "category": "typing/producer-consumer-drift"
    },
    {
        "id": "DD1-5",
        "location": "apps/caramel-app/src/app/api/classify-cart/route.ts:10-11,59-67",
        "quote": "route.ts:10-11: // Cap payload size to protect the route from noisy senders.\nconst MAX_BODY_BYTES = 8 * 1024\nroute.ts:59-67:    const contentLength = Number(req.headers.get('content-length') || 0)\n    if (contentLength > MAX_BODY_BYTES) {\n        return NextResponse.json(\n            { error: 'payload too large' },\n            { status: 413 },\n        )\n    }\n\n    const raw = await req.json().catch(() => null)",
        "what": "The 8KB payload cap inspects only the client-declared Content-Length header: a chunked request (no header -> Number(null || 0) = 0) or an understated header passes the check, after which req.json() buffers and parses the entire actual body in memory — sanitize()'s per-field caps apply only after the full parse completes. The comment claims the constant 'protect[s] the route', which is not what the code enforces.",
        "why_it_matters": "In scope under 'perf (OOM only)': a hostile sender can make the Node process buffer and JSON.parse arbitrarily large bodies per request; combined with DD1-6 (limiter exemption via a published constant) such requests can also be unthrottled. The misleading comment invites the next agent to rely on a guarantee that does not exist.",
        "severity": "Medium",
        "confidence": 0.85,
        "verified": true,
        "survived_adversarial_review": null,
        "fix_direction": "Read the request stream with a byte counter and abort once MAX_BODY_BYTES is exceeded (then JSON.parse the bounded string); keep the header comparison only as a cheap early 413. Fix the comment to describe what is actually enforced.",
        "effort": "S",
        "category": "perf/resource-limits"
    },
    {
        "id": "DD1-6",
        "location": "apps/caramel-app/src/lib/rateLimit.ts:56-63,91; apps/caramel-extension/background.js:23,160-165",
        "quote": "rateLimit.ts:59-63:    const key =\n        req.headers.get('x-api-key') || req.headers.get('x-extension-api-key')\n    const expected = process.env.EXTENSION_API_KEY\n    return Boolean(key && expected && key === expected)\nrateLimit.ts:91:    if (isExtensionClient(req)) return null\nbackground.js:23: const EXTENSION_API_KEY = 'WXqEpm2uOV5jjJXPpnQFyZiNdaPVUrtd2LIrf4kc1JA'\nbackground.js:161-164:            fetchWithTimeout(caramelUrl('api/classify-cart'), {\n                method: 'POST',\n                headers: { 'Content-Type': 'application/json' },\n                body: JSON.stringify(message.signals || {}),",
        "what": "checkRateLimit exempts any request bearing EXTENSION_API_KEY from ALL throttling ('if (isExtensionClient(req)) return null' — burst and minute limiters both skipped), and that key is a hardcoded constant shipped in the public extension source. classify-cart is the one route where every cache-missing request spends real money (an OpenRouter completion), yet its own legitimate caller does not even send the key — the background classifyCart fetch sends only Content-Type. On this route the exemption therefore grants unlimited, unmetered LLM spend exclusively to whoever lifts the published constant, and nothing to the product. Cache misses are attacker-controlled (any novel title/cart_items yields a fresh sha256 key), so each request is a fresh paid model call.",
        "why_it_matters": "Cost control on the paid surface reduces to a public string: the 30/min/IP 'mutation' budget becomes infinite for anyone who reads the CRX source. This is the operability/cost angle, distinct from the key-exposure security finding the scanners already filed (hotspots-b DD 'Hardcoded EXTENSION_API_KEY') — even after a key rotation, an exempt-from-everything null return remains the wrong shape for a route with per-request provider cost.",
        "severity": "High",
        "confidence": 0.9,
        "verified": true,
        "survived_adversarial_review": null,
        "fix_direction": "Smallest fix: remove the extension exemption for classify-cart (its caller never uses it) — call the limiter unconditionally there; better, replace the blanket null with a per-key rate limiter so trusted callers get a higher budget, never an infinite one. Key rotation/server-side move is the companion scanner finding.",
        "effort": "S",
        "category": "operability/cost-control"
    },
    {
        "id": "DD1-7",
        "location": "apps/caramel-app/src/lib/cartClassifier.ts:110-146",
        "quote": "cartClassifier.ts:113-117:    } catch {\n        const m = raw.match(/\\{[\\s\\S]*\\}/)\n        if (!m) throw new Error('llm returned non-json')\n        parsed = JSON.parse(m[0])\n    }\ncartClassifier.ts:135-140:    const confidence =\n        typeof obj.confidence === 'number' &&\n        obj.confidence >= 0 &&\n        obj.confidence <= 1\n            ? obj.confidence\n            : 0.5",
        "what": "parseResponse validates primary strictly (throws on unknown category — good) but silently coerces everything else: an invalid or duplicate secondary is dropped to undefined (:128-134), and a missing/out-of-range confidence is defaulted to 0.5 — fabricated data indistinguishable downstream from a real model score (the extension logs '(conf: 0.5)' as though the model said it). The regex rescue re-parses prose-wrapped output even though the request already sets response_format json_object — a 'try A, else B' second-guess layer that masks a misbehaving model instead of surfacing it, and at temperature 0 the masked failure repeats deterministically on every cache miss.",
        "why_it_matters": "Silent coercions are how eval-worthy model regressions stay invisible (v5: real production AI failures should become eval cases — these paths destroy the evidence). If a model update starts emitting confidence as a string or wrapping JSON in prose, nothing logs and nothing fails; quality just sags. The rescue branch is the exact trial-and-error layering v5 bans unless justified and announced.",
        "severity": "Low",
        "confidence": 0.9,
        "verified": true,
        "survived_adversarial_review": null,
        "fix_direction": "Validate the whole object with ClassificationSchema (DD1-4); on secondary/confidence violations and on regex-rescue activation, log a warning carrying the raw model output (feeds future eval cases). Keep the prose-rescue only if evals show a routed model ignoring response_format — and make it announce itself when it fires.",
        "effort": "S",
        "category": "ai-quality/silent-coercion"
    },
    {
        "id": "DD1-8",
        "location": "apps/caramel-extension/popup.js:623-624; apps/caramel-app/src/lib/cartClassifier.ts:4-21",
        "quote": "popup.js:623-624:                              const cartHint = c.cartCategory\n                                  ? ` — your cart looks like <b>${escHtml(c.cartCategory)}</b>${c.cartCategorySecondary ? ` / ${escHtml(c.cartCategorySecondary)}` : ''}`\ncartClassifier.ts:7-9:    'books_media',\n    'electronics',\n    'food_grocery',",
        "what": "The popup renders the model's wire-format enum tokens as user-facing copy: a shopper literally sees 'your cart looks like books_media' or 'health_supplements / food_grocery', underscores and all. CATEGORY_ENUM doubles as machine contract and display string, with no label map on either side of the wire.",
        "why_it_matters": "Internal identifiers surface in a trust-sensitive warning ('this code may not apply'), and because UI copy depends on raw enum spelling, renaming a category server-side silently changes end-user text — contract vocabulary and copywriting are welded together.",
        "severity": "Low",
        "confidence": 0.95,
        "verified": true,
        "survived_adversarial_review": null,
        "fix_direction": "Add a CATEGORY_LABELS map beside the popup renderer ('books_media' -> 'Books & Media', etc.); render labels, keep tokens for logic and the wire.",
        "effort": "S",
        "category": "clarity/ux-contract-leak"
    },
    {
        "id": "DD1-9",
        "location": "apps/caramel-extension/cart-signals.js:21-25",
        "quote": "cart-signals.js:21-25:    function baseDomain() {\n        const parts = location.hostname.split('.').filter(Boolean)\n        if (parts.length <= 2) return parts.join('.')\n        return parts.slice(-2).join('.')\n    }",
        "what": "The domain the extension sends — the classifier's anchor signal and half of the server cache key — is computed as 'last two hostname labels', which collapses every multi-part-TLD store to its public suffix: www.amazon.co.uk -> 'co.uk', shop.example.com.au -> 'com.au'. The route's regex (route.ts:18, /^[a-z0-9.-]{3,120}$/) accepts these without complaint.",
        "why_it_matters": "For entire country markets the prompt's strongest field is noise ('domain':'co.uk'), weakening classification exactly where title/cart-item extraction is also least reliable; unrelated ccTLD stores whose normalized title/items coincide can additionally collide on cache entries. Also degrades any future per-domain analysis of classify traffic.",
        "severity": "Low",
        "confidence": 0.9,
        "verified": true,
        "survived_adversarial_review": null,
        "fix_direction": "Send location.hostname as-is (the LLM handles subdomains fine), or reuse the extension's existing store-domain matching used for coupon lookup — a PSL dependency is overkill.",
        "effort": "S",
        "category": "correctness/input-signal"
    },
    {
        "id": "DD1-10",
        "location": "apps/caramel-app/src/lib/openrouter.ts:49-54; apps/caramel-extension/background.js:20-22",
        "quote": "openrouter.ts:49-54:            headers: {\n                'Content-Type': 'application/json',\n                Authorization: `Bearer ${key}`,\n                'HTTP-Referer': 'https://caramel.app',\n                'X-Title': 'Caramel Extension',\n            },\nbackground.js:20-22: globalThis.CARAMEL_BASE_URL = _isDevInstall()\n    ? 'https://dev.grabcaramel.com'\n    : 'https://grabcaramel.com'",
        "what": "The OpenRouter attribution headers are hardcoded and wrong: HTTP-Referer claims 'https://caramel.app' while the product lives at grabcaramel.com (per the extension's own base-URL switch and CI's NEXT_PUBLIC_BASE_URL), and X-Title says 'Caramel Extension' although the caller is the Next.js server, not the extension.",
        "why_it_matters": "OpenRouter uses these headers for app attribution, dashboards, and abuse contact — a wrong domain misattributes the account's traffic (or credits a domain the team doesn't own) and makes provider-side incident correlation harder. Small, but exactly the kind of copied constant a light model will faithfully propagate into the next integration.",
        "severity": "Low",
        "confidence": 0.85,
        "verified": true,
        "survived_adversarial_review": null,
        "fix_direction": "Derive HTTP-Referer from NEXT_PUBLIC_BASE_URL (already env-driven) and rename X-Title to describe the real caller (e.g. 'Caramel App — cart classifier').",
        "effort": "S",
        "category": "operability/config-hygiene"
    }
]
```
