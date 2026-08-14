// The probe's judgement, with no browser attached.
//
// Everything in this file is pure: it takes an observation object and returns
// a verdict, an exit code and the reasons behind both. That separation is the
// point — the half that drives Chromium needs a live store to exercise, but
// the half that decides whether a config WORKS can be pinned by unit tests
// that run in CI on every push, so a rename or a loosened rule fails the build
// instead of silently downgrading every future run to "looks fine".
//
// Vocabulary note: a verdict is a claim about the CONFIG, not about the
// extension's mood. `INCONCLUSIVE_*` exists because the most expensive class of
// mistake here is reading "the prompt never appeared" as a defect when the cart
// was empty the whole time and silence was the CORRECT behaviour.

import { SEEDABLE_PLATFORMS } from './seed.mjs'

// Still `ext-probe/1`. The widening of the seeder past Shopify only ADDED
// fields to `observation.platform` (`detected`, `productFeedOk`, `cartApiOk`);
// nothing was renamed or removed, so every consumer written against v1 keeps
// reading exactly what it read before. The two Shopify-shaped fields it used
// to carry alone are kept beside the new ones for the same reason — reports
// recorded before the widening stay comparable field-for-field.
export const SCHEMA = 'ext-probe/1'

/**
 * The ten verdicts, in first-match-wins order. `classify` walks this list from
 * the top and returns on the first precondition that holds — the order IS the
 * semantics, so reordering entries changes results.
 */
export const VERDICTS = Object.freeze([
    'INCONCLUSIVE_SEED',
    'INCONCLUSIVE_PLATFORM',
    'INCONCLUSIVE_CONFIG_STALE',
    'RED_NOT_DETECTED',
    'RED_NO_COUPONS',
    'RED_NO_PROMPT',
    'RED_PROMPT_DEGENERATE',
    'RED_APPLY_FAILED',
    'AMBER_NO_INDICATORS',
    'GREEN',
])

/**
 * Not a verdict about the config — a report that the probe itself fell over
 * before it could form one. Kept out of VERDICTS deliberately: a caller
 * counting reds must never absorb a harness crash as store evidence.
 */
export const PROBE_ERROR = 'PROBE_ERROR'

/**
 * The probe was pointed at a directory that is not a loadable extension, so
 * Chromium would have started with NOTHING installed. Its own sentinel rather
 * than a flavour of PROBE_ERROR because the failure is silent by nature: a
 * browser with no extension answers every question with "nothing happened",
 * which reads exactly like a broken config. Days of ext-QA measurements were
 * taken that way after the WXT migration moved the manifest to
 * `.output/chrome-mv3` — the only tell in the whole report was `vnull` in the
 * log header. A probe that cannot load the extension must never produce a
 * verdict.
 */
export const PROBE_NO_EXTENSION = 'PROBE_NO_EXTENSION'

// Exit codes are the machine contract for shell callers, so they are stable
// numbers, not indexes into the array above. 0 is GREEN and nothing else.
// 1 and 2 are avoided on purpose (node's own uncaught-throw / bad-usage codes),
// and everything stays well under 125 so it can't collide with shell/signal
// conventions.
export const EXIT_CODES = Object.freeze({
    GREEN: 0,
    AMBER_NO_INDICATORS: 10,
    RED_NOT_DETECTED: 20,
    RED_NO_COUPONS: 21,
    RED_NO_PROMPT: 22,
    RED_PROMPT_DEGENERATE: 23,
    RED_APPLY_FAILED: 24,
    INCONCLUSIVE_SEED: 30,
    INCONCLUSIVE_PLATFORM: 31,
    INCONCLUSIVE_CONFIG_STALE: 32,
    [PROBE_ERROR]: 70,
    [PROBE_NO_EXTENSION]: 71,
})

export function exitCodeFor(verdict) {
    const code = EXIT_CODES[verdict]
    // An unknown verdict is a programming error in the probe, not a store
    // result, so it exits like a crash rather than like a red.
    return typeof code === 'number' ? code : EXIT_CODES[PROBE_ERROR]
}

/**
 * The events that BOTH witnesses can emit. The console trail carries far more
 * `AUTO_INSERT_*` lines than `recordTiming` ever writes, so comparing the full
 * sets would manufacture disagreement on every run; only this subset is a fair
 * comparison. Source: the `recordTiming(` call sites in coupon-apply.js,
 * coupon-fetch.js and store-detect.js.
 */
export const COMPARABLE_EVENTS = Object.freeze([
    'AUTO_INSERT_ATTEMPT_START',
    'AUTO_INSERT_ATTEMPT_END',
    'AUTO_INSERT_FETCHCOUPONS_START',
    'AUTO_INSERT_FETCHCOUPONS_END',
    'STORE_LIST_FETCH_FAILED',
])

/** The newest-N cap `recordTiming` applies at write time (caramel-base.js). */
export const TIMINGS_CAP = 50

/**
 * Everything the classifier is allowed to look at. Anything the probe could
 * not observe stays `null` — never `false`, because "we did not see it" and
 * "it did not happen" lead to different verdicts and collapsing them is how a
 * harness starts lying.
 */
export function emptyObservation() {
    return {
        seed: { ok: null, detail: '', rejectedAdds: 0, adds: 0 },
        platform: {
            // Which platform's cart mechanism was used, named from markup the
            // platform itself emits. `unknown` means no seeder speaks for this
            // store — an honest abandon, never a Shopify-shaped guess.
            detected: null,
            // The platform-neutral facts the classifier reads: its product
            // source listed something addable, and its cart endpoint answered.
            productFeedOk: null,
            cartApiOk: null,
            // The literal Shopify legs, set only on a Shopify run. Kept beside
            // the two above so reports recorded before the seeder widened past
            // Shopify stay comparable field-for-field.
            productsJsonOk: null,
            cartJsOk: null,
            // WHY the answer above is the answer. `unknown` used to arrive with
            // one sentence — "no platform marker found" — that a blocked store,
            // a challenge page and a genuinely unrecognised platform all
            // produced, which is why 11 of 24 stores in the 2026-08-14 batch
            // were unreadable. These carry the difference.
            signal: null,
            // 'markup' | 'capability' | null — which leg decided.
            source: null,
            // The caller's platform hint and whether the evidence agreed with
            // it. A hint never decides on its own; see resolvePlatform.
            hint: null,
            hintAgreed: null,
            // Every cart-API probe refused (401/403/429/503/network). We did
            // not learn the store is on another platform; we learned nothing.
            blocked: null,
            // The HTTP status of the navigation the detection ran against.
            navigationStatus: null,
            // The document we were actually looking at, recorded only when the
            // platform came back unknown.
            document: null,
            // Present only when a second look was taken: what the first one saw.
            firstLook: null,
        },
        // Read BEFORE the wait window. See probe.mjs for why that ordering is
        // load-bearing rather than incidental.
        cartItemsAtArrival: null,
        config: {
            // "the domain list under test was fetched from the API during
            // THIS run". Established from the extension's own storage — the
            // cache key the probe removed coming back — because the console
            // line it used to be read from is compiled out of a production
            // build and its silence therefore proves nothing.
            servedFromApi: null,
            // Whether that removal actually happened. Without it a repopulated
            // key could just be yesterday's cache, so the proof above is only
            // a proof when this is true.
            cacheClearedBeforeRun: null,
            expected: null,
            served: null,
            matches: null,
            mismatchedFields: [],
        },
        detection: { checkoutViaCartPayload: null, matchedPromoBox: null },
        coupons: { fetchStarted: null, fetchEnded: null, count: null },
        prompt: {
            present: false,
            appearedMs: null,
            rect: null,
            opacity: null,
            visibility: null,
            cssIsFallback: null,
            shadowChildren: null,
        },
        // The three selectors that turn "the prompt showed up" into "the config
        // works". All three are nullable in the producing schema, so a config
        // can legitimately arrive with none of them — that config can never be
        // GREEN, and saying so out loud is the whole point of AMBER.
        indicators: {
            priceContainer: null,
            successIndicator: null,
            errorIndicator: null,
        },
        apply: {
            submitted: 0,
            successFiredOnGoodCode: null,
            errorFiredOnInvalidCode: null,
            totalBefore: null,
            totalAfter: null,
        },
    }
}

function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** Shallow-per-section merge onto the defaults, so callers may pass partials. */
export function normalizeObservation(partial) {
    const base = emptyObservation()
    if (!isPlainObject(partial)) return base
    for (const key of Object.keys(base)) {
        const incoming = partial[key]
        if (incoming === undefined) continue
        base[key] =
            isPlainObject(base[key]) && isPlainObject(incoming)
                ? { ...base[key], ...incoming }
                : incoming
    }
    return base
}

/**
 * Did the extension fetch the domain list from the API during THIS run?
 *
 * Two independent witnesses to one fact, and they are not interchangeable.
 *
 * The STORAGE witness is load-bearing. The probe removes the extension's
 * supported-stores cache key before the run, and the extension rewrites that
 * key only on the branch that just fetched from the API — so a key that comes
 * back holding data IS the fetch. It works on the production build, which is
 * the build ext-QA measures.
 *
 * The CONSOLE witness can only CONFIRM, never deny. `log` in caramel-base.js
 * is `CARAMEL_ENV.verbose ? console.log : noop` and the production stamp sets
 * `verbose: false` on purpose — content scripts run on every https origin, so
 * a shipped build must never write into a shopper's store console (verified in
 * the artifacts: `.output/chrome-mv3` carries `verbose:!1`, the dev build
 * `verbose:!0`, 2026-08-14). Its absence therefore says nothing at all, and
 * reading that silence as `false` is what pinned every production run at
 * INCONCLUSIVE_CONFIG_STALE and meant the served-vs-expected comparison never
 * once ran.
 *
 * @returns {boolean|null} `null` when neither witness could speak — not
 *   observed, which is not the same as "it did not happen".
 */
export function deriveServedFromApi({
    cacheCleared = false,
    cacheReadOk = false,
    cacheHasData = false,
    loggedApiLoad = false,
} = {}) {
    if (cacheCleared && cacheReadOk) return cacheHasData
    if (loggedApiLoad) return true
    return null
}

const SELECTOR_FIELDS = ['priceContainer', 'successIndicator', 'errorIndicator']

function missingIndicators(o) {
    return SELECTOR_FIELDS.filter(f => !o.indicators[f])
}

function trailComplete(o) {
    return (
        o.config.servedFromApi === true &&
        (o.detection.checkoutViaCartPayload === true ||
            o.detection.matchedPromoBox === true) &&
        o.coupons.fetchStarted === true &&
        o.coupons.fetchEnded === true &&
        typeof o.coupons.count === 'number' &&
        o.coupons.count > 0
    )
}

function promptDegeneracies(p) {
    const bad = []
    if (!p.rect || !p.rect.w || !p.rect.h)
        bad.push(
            `zero geometry (${p.rect ? `${p.rect.w}x${p.rect.h}` : 'no rect'})`,
        )
    // The rect itself is RECORDED, never compared against a remembered
    // 300x81 — that number was one measurement on one store, not a contract,
    // and hard-coding it would turn every legitimate design change into a red.
    if (p.opacity !== null && String(p.opacity) !== '1')
        bad.push(`opacity ${p.opacity}`)
    if (p.visibility !== null && p.visibility !== 'visible')
        bad.push(`visibility ${p.visibility}`)
    if (p.cssIsFallback === true)
        bad.push('shadow-root CSS is the fallback stub, not the real sheet')
    return bad
}

function priceStrictlyDecreased(a) {
    return (
        typeof a.totalBefore === 'number' &&
        typeof a.totalAfter === 'number' &&
        a.totalAfter < a.totalBefore
    )
}

/**
 * First matching precondition wins. Returns `{verdict, reasons, exitCode}`.
 */
export function classify(partialObservation) {
    const o = normalizeObservation(partialObservation)
    const done = (verdict, ...reasons) => ({
        verdict,
        reasons,
        exitCode: exitCodeFor(verdict),
    })

    // 1 — before everything else. An empty cart is not a checkout, so the
    // extension staying silent is CORRECT and grading it as a failure is the
    // single easiest way to fabricate a defect that was never there.
    if (o.seed.ok !== true)
        return done(
            'INCONCLUSIVE_SEED',
            `seed did not succeed: ${o.seed.detail || 'no detail'}`,
        )
    if (o.cartItemsAtArrival === 0)
        return done(
            'INCONCLUSIVE_SEED',
            'cart held 0 items when the extension arrived — "no prompt" is the correct behaviour here, not a defect',
        )

    // 2 — the seed path can only speak for a platform it implements. A store
    // whose platform is unrecognised, or whose product/cart endpoints did not
    // answer, produces no evidence about its config either way.
    if (!SEEDABLE_PLATFORMS.includes(o.platform.detected))
        return done(
            'INCONCLUSIVE_PLATFORM',
            `store platform is ${
                o.platform.detected === null
                    ? 'unobserved'
                    : `"${o.platform.detected}"`
            } — the seeder speaks ${SEEDABLE_PLATFORMS.join('/')} and cannot seed a cart here`,
        )
    if (o.platform.productFeedOk !== true || o.platform.cartApiOk !== true)
        return done(
            'INCONCLUSIVE_PLATFORM',
            `the ${o.platform.detected} endpoints did not answer (product feed ok=${o.platform.productFeedOk}, cart ok=${o.platform.cartApiOk})`,
        )

    // 3 — the config an agent edits is several hops from what the extension
    // reads, and the extension additionally caches the domain list. A verdict
    // computed against the OLD config is a lie, so staleness is detected by
    // COMPARING what was served against what is under test — never by waiting
    // a fixed number of seconds and hoping.
    if (o.config.servedFromApi !== true)
        return done(
            'INCONCLUSIVE_CONFIG_STALE',
            o.config.cacheClearedBeforeRun === true
                ? 'the supported-domain cache was cleared before the run and never came back — the extension did not fetch the domain list from the API'
                : 'the supported-domain cache could not be cleared and no API load was observed — the run may have been served a stale domain list',
        )
    if (o.config.matches === false)
        return done(
            'INCONCLUSIVE_CONFIG_STALE',
            `served config differs from the config under test: ${
                o.config.mismatchedFields.join(', ') || 'unspecified fields'
            }`,
        )

    // 4 — real cart, and the extension still never recognised the checkout.
    if (
        o.detection.checkoutViaCartPayload !== true &&
        o.detection.matchedPromoBox !== true
    )
        return done(
            'RED_NOT_DETECTED',
            `cart had ${o.cartItemsAtArrival} item(s) but neither CHECKOUT_VIA_CART_PAYLOAD nor a matched promo box was observed`,
        )

    // 5
    if (o.coupons.count === 0)
        return done(
            'RED_NO_COUPONS',
            'AUTO_INSERT_FETCHCOUPONS_END reported count: 0 — detected, but the catalogue had nothing to try',
        )

    // 6
    if (!o.prompt.present)
        return done(
            'RED_NO_PROMPT',
            `#caramel-small-prompt never rendered within the wait window (coupon count: ${
                o.coupons.count === null ? 'unobserved' : o.coupons.count
            })`,
        )

    // 7
    const degeneracies = promptDegeneracies(o.prompt)
    if (degeneracies.length)
        return done(
            'RED_PROMPT_DEGENERATE',
            `prompt rendered but unusable: ${degeneracies.join('; ')}`,
        )

    // 8 — codes went in, nothing came back out. Note this requires BOTH
    // indicators to have stayed quiet AND the price to have held: a fired
    // error indicator means the store answered, which is a different story.
    if (
        o.apply.submitted >= 1 &&
        o.apply.successFiredOnGoodCode !== true &&
        o.apply.errorFiredOnInvalidCode !== true &&
        !priceStrictlyDecreased(o.apply)
    )
        return done(
            'RED_APPLY_FAILED',
            `${o.apply.submitted} code(s) submitted; no success indicator, no error indicator, and the total did not move`,
        )

    // 9 — the honest bucket. Everything that is not provably broken and not
    // provably working lands here, because the alternative is a GREEN that
    // means "we did not look".
    const unproven = []
    const missing = missingIndicators(o)
    if (missing.length)
        unproven.push(`served config has no ${missing.join('/')} selector`)
    if (!trailComplete(o))
        unproven.push(
            'the detection -> fetch-start -> fetch-end trail is incomplete',
        )
    if (!priceStrictlyDecreased(o.apply))
        unproven.push(
            `no strict price decrease via priceContainer (before=${o.apply.totalBefore}, after=${o.apply.totalAfter})`,
        )
    if (o.apply.successFiredOnGoodCode !== true)
        unproven.push('the success indicator did not fire on a good code')
    if (o.apply.errorFiredOnInvalidCode !== true)
        // The negative control. Without it, "no error appeared" is
        // indistinguishable from "the error selector is wrong".
        unproven.push(
            'the error indicator did not fire on a deliberately invalid code (negative control missing)',
        )
    if (unproven.length) return done('AMBER_NO_INDICATORS', ...unproven)

    // 10
    return done(
        'GREEN',
        'full chain proven: seeded cart, API-served config under test, complete detection trail, healthy prompt, strict price decrease, success indicator on a good code, error indicator on an invalid one',
    )
}

const EVENT_RE =
    /\b(AUTO_INSERT_[A-Z_]+|CHECKOUT_VIA_[A-Z_]+|STORE_LIST_FETCH_FAILED)\b/g

export function consoleEventCounts(consoleTrail) {
    const counts = {}
    for (const line of consoleTrail || []) {
        const seen = new Set()
        for (const m of String(line).matchAll(EVENT_RE)) {
            // One line can only evidence an event once, however many times the
            // name is echoed inside its own payload.
            if (seen.has(m[1])) continue
            seen.add(m[1])
            counts[m[1]] = (counts[m[1]] || 0) + 1
        }
    }
    return counts
}

export function timingEventCounts(timings) {
    const counts = {}
    for (const entry of timings || []) {
        const name = entry && entry.event
        if (!name) continue
        counts[name] = (counts[name] || 0) + 1
    }
    return counts
}

/**
 * Console trail and storage timings are two INDEPENDENT witnesses to the same
 * run. When they disagree the probe says so and reports both — it never picks
 * a winner, because the interesting bug is usually the disagreement itself
 * (a log emitted on a path that never reached storage, or storage evicting
 * evidence the console still holds).
 */
export function diffWitnesses(consoleTrail, timings) {
    const consoleCounts = consoleEventCounts(consoleTrail)
    const timingCounts = timingEventCounts(timings)
    const details = []
    for (const event of COMPARABLE_EVENTS) {
        const c = consoleCounts[event] || 0
        const t = timingCounts[event] || 0
        if (c !== t) details.push({ event, console: c, timings: t })
    }
    const atCap = (timings || []).length >= TIMINGS_CAP
    return {
        detected: details.length > 0,
        // Reported, not applied: at the cap, storage may legitimately have
        // dropped the oldest entries, so a difference is explainable — but the
        // probe still refuses to silently forgive it.
        timingsAtCap: atCap,
        details,
        consoleCounts,
        timingCounts,
    }
}

/**
 * The single schema-versioned object the probe prints. Pure, so the golden
 * tests can build one without a browser.
 */
export function buildReport({
    target = null,
    build = null,
    observation = null,
    witnesses = null,
    logFile = null,
    reportFile = null,
    screenshot = null,
    durationMs = null,
    error = null,
    // Which non-verdict sentinel the error is. Defaults to PROBE_ERROR so
    // every existing caller keeps its behaviour; the probe passes
    // PROBE_NO_EXTENSION when it never had an extension to measure.
    errorVerdict = PROBE_ERROR,
} = {}) {
    if (error) {
        return {
            schema: SCHEMA,
            verdict: errorVerdict,
            exitCode: exitCodeFor(errorVerdict),
            reasons: [String(error)],
            target,
            build,
            observation: observation ? normalizeObservation(observation) : null,
            witnesses,
            logFile,
            reportFile,
            screenshot,
            durationMs,
        }
    }
    const normalized = normalizeObservation(observation)
    const { verdict, reasons, exitCode } = classify(normalized)
    return {
        schema: SCHEMA,
        verdict,
        exitCode,
        reasons,
        target,
        build,
        observation: normalized,
        witnesses,
        logFile,
        reportFile,
        screenshot,
        durationMs,
    }
}
