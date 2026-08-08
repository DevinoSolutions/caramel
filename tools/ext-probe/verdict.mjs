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
        platform: { productsJsonOk: null, cartJsOk: null },
        // Read BEFORE the wait window. See probe.mjs for why that ordering is
        // load-bearing rather than incidental.
        cartItemsAtArrival: null,
        config: {
            servedFromApi: null,
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

    // 2 — the Shopify-shaped seed path cannot speak for a store that is not
    // Shopify-shaped.
    if (o.platform.productsJsonOk !== true || o.platform.cartJsOk !== true)
        return done(
            'INCONCLUSIVE_PLATFORM',
            `store is not Shopify-shaped (products.json ok=${o.platform.productsJsonOk}, cart.js ok=${o.platform.cartJsOk})`,
        )

    // 3 — the config an agent edits is several hops from what the extension
    // reads, and the extension additionally caches the domain list. A verdict
    // computed against the OLD config is a lie, so staleness is detected by
    // COMPARING what was served against what is under test — never by waiting
    // a fixed number of seconds and hoping.
    if (o.config.servedFromApi !== true)
        return done(
            'INCONCLUSIVE_CONFIG_STALE',
            'the "Loaded supported domains from API" line never appeared — the run may have been served a cached domain list',
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
    screenshot = null,
    durationMs = null,
    error = null,
} = {}) {
    if (error) {
        return {
            schema: SCHEMA,
            verdict: PROBE_ERROR,
            exitCode: exitCodeFor(PROBE_ERROR),
            reasons: [String(error)],
            target,
            build,
            observation: observation ? normalizeObservation(observation) : null,
            witnesses,
            logFile,
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
        screenshot,
        durationMs,
    }
}
