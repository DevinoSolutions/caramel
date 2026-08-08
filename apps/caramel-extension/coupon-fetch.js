// owns: coupon list fetch + classify (fetchCoupons, RESTRICTED_STATUSES, classifyCartCategory, getCoupons)
// load after: caramel-base.js, dom-utils.js, store-detect.js, coupon-apply.js, and coupon-constants.generated.js (window.CaramelCoupons — loaded first in every manifest/index.html)

/* --------------------------------------------------  coupon list */
// Called from other split content-script files (cross-file content-script
// call — oxlint's per-file analysis can't see it).
// oxlint-disable-next-line no-unused-vars
async function fetchCoupons(site, kw, category) {
    // Delegate network fetch to background/service worker to avoid CORS failures
    const meta = { site, kw, category }
    try {
        log(
            'AUTO_INSERT_FETCHCOUPONS_START',
            Object.assign({}, meta, { t: performance.now() }),
        )
        recordTiming('AUTO_INSERT_FETCHCOUPONS_START', meta)
        // caramelSendMessage (caramel-base.js) bounds the wait and surfaces a
        // closed port: the raw sendMessage form this replaced could hang the
        // apply flow forever on an evicted worker — measured live 2026-08-07,
        // the log ended at FETCHCOUPONS_START with no END and no error, and
        // the shopper saw nothing on a store with coupons.
        const resp = await caramelSendMessage({
            action: 'fetchCoupons',
            site,
            kw,
            category,
        })
        if (resp?.error) {
            log('fetchCoupons background error', resp.error)
            recordTiming('AUTO_INSERT_FETCHCOUPONS_END', {
                count: 0,
                error: resp.error,
            })
            throw new Error(resp.error)
        }
        const d = resp?.coupons || []
        log('AUTO_INSERT_FETCHCOUPONS_END', {
            count: d.length,
            t: performance.now(),
        })
        recordTiming('AUTO_INSERT_FETCHCOUPONS_END', { count: d.length })
        log('Fetched', d.length, 'coupons')
        return d
    } catch (e) {
        log('fetchCoupons error', e)
        recordTiming('AUTO_INSERT_FETCHCOUPONS_END', {
            count: 0,
            error: String(e),
        })
        throw e
    }
}
// Statuses that signal a coupon has restrictions the user might trip over.
// When ANY returned coupon carries one of these, we classify the cart so the
// UI can warn the user "your cart is X, this code is for Y." Sourced from
// window.CaramelCoupons (coupon-constants.generated.js, loaded before this
// file — F-006) instead of a hard-coded literal, so this can't re-drift
// from the app's src/lib/coupons.ts.
const RESTRICTED_STATUSES = new Set(window.CaramelCoupons.RESTRICTED_STATUSES)

/* Coupon codes are SCRAPED, so they arrive with whatever the source page had
 * around them — trailing newlines, non-breaking spaces, zero-width characters.
 * The apply path writes the string into the store's input verbatim, so an
 * unclean code is typed unclean, the store rejects it, and that rejection is
 * reported back as a genuine coupon failure — teaching the trust loop the wrong
 * thing about a code that was fine. It also breaks the manual Copy button,
 * which hands the same string to the user's clipboard.
 *
 * Normalises once, here, so every consumer (apply loop, manual list, copy
 * button) sees the same clean value. Internal spaces are LEFT ALONE — a few
 * stores really do issue codes containing them. Codes left empty are dropped;
 * an empty code can only ever waste an attempt. */
function _caramelCleanCodes(list) {
    if (!Array.isArray(list)) return list
    return list
        .map(c => {
            if (!c || typeof c.code !== 'string') return c
            const code = c.code
                // zero-width chars + BOM: invisible on screen, fatal to an
                // exact match. Escaped so the class stays reviewable in diff.
                .replace(/[\u200b-\u200d\ufeff]/g, '')
                // any unicode space (incl. \u00a0) or control char -> plain
                .replace(/[\s\u00a0]+/g, ' ')
                .trim()
            return code === c.code ? c : { ...c, code }
        })
        .filter(c => !c || typeof c.code !== 'string' || c.code.length > 0)
}

/* What a coupon is plausibly worth on THIS cart, in the cart's own money.
 *
 * The API gives every coupon a `discount_type` (PERCENTAGE / CASH / SAVE) and a
 * `discount_amount`. Nothing consumed them, so codes were attempted in whatever
 * order the API returned — and the apply loop stops at the first one that moves
 * the total. On personalabs.com (QA sweep 2026-08-06) that meant taking TREAT22
 * for $1.35 on a $135 cart while flash35 — sitting in the SAME list — gave
 * $47.25 when applied by hand seconds later on the identical cart.
 *
 * This is an estimate from metadata we know can lie (TREAT22 advertised 30% and
 * delivered 1%), so it is used ONLY to choose what to try first. Nothing is ever
 * reported to the shopper from it; every figure they see is still measured off
 * their own cart. A percentage is capped at 100 and a cash amount at the cart
 * total, because neither can take off more than the cart holds.
 */
// Cross-file content-script call — per-file analysis can't see it.
// oxlint-disable-next-line no-unused-vars
function caramelEstimatedValue(coupon, totalMinor) {
    const amount = Number(coupon?.discount_amount)
    if (!Number.isFinite(amount) || amount <= 0) return 0
    const total = Number.isFinite(totalMinor) && totalMinor > 0 ? totalMinor : 0
    const type = String(coupon?.discount_type || '').toUpperCase()
    if (type === 'PERCENTAGE') {
        const pct = Math.min(amount, 100) / 100
        return total ? pct * total : amount
    }
    // CASH / SAVE are already an amount of money; minor units to match the cart.
    const cash = amount * 100
    return total ? Math.min(cash, total) : amount
}

/* Best-first ordering. Stable, so codes we can't value keep their original
 * order — an unvalued coupon is unknown, not worthless, and sinking it below a
 * known-tiny one would be its own way of losing money. */
// Cross-file content-script call — per-file analysis can't see it.
// oxlint-disable-next-line no-unused-vars
function caramelRankByValue(list, totalMinor) {
    return (Array.isArray(list) ? list : [])
        .map((c, i) => ({ c, i, v: caramelEstimatedValue(c, totalMinor) }))
        .sort((a, b) => b.v - a.v || a.i - b.i)
        .map(x => x.c)
}

async function classifyCartCategory() {
    try {
        const cs = window.CaramelCartSignals
        if (!cs || typeof cs.collectCartSignals !== 'function') return null
        const signals = await cs.collectCartSignals()
        // Bounded wait + closed-port detection; a rejection lands in this
        // function's own catch and classification degrades to null, exactly
        // like any other non-fatal classify error.
        const result = await caramelSendMessage({
            action: 'classifyCart',
            signals,
        })
        if (result && result.primary && !result.error) {
            log(
                'Cart category:',
                result.primary,
                '(conf:',
                result.confidence,
                ')',
            )
            return {
                primary: result.primary,
                secondary: result.secondary,
                confidence: result.confidence,
            }
        }
    } catch (e) {
        log('classifyCart non-fatal error', e)
    }
    return null
}

// Called from other split content-script files (cross-file content-script
// call — oxlint's per-file analysis can't see it).
// oxlint-disable-next-line no-unused-vars
async function getCoupons(rec) {
    // Dev hook: deterministic coupons when using #caramel-test. Gated to
    // development-stamped builds so a #caramel-test link can't make a shipped
    // build fire mock codes against a real store's checkout.
    if (
        !CARAMEL_ENV.isProduction &&
        location.hash &&
        location.hash.includes('caramel-test')
    ) {
        log('DEV MODE: returning mocked coupons')
        return [{ code: 'TEST10' }, { code: 'TEST20' }, { code: 'TEST30' }]
    }

    // 1) Use the codes already fetched at detection time (cached) — falls back
    //    to a fresh fetch if the cache is cold. Avoids a double network call.
    const list = _caramelCleanCodes(await getCachedCodes(rec))

    // 2) Only classify the cart if any returned coupon is flagged as restricted
    //    — that's when the category meaningfully helps the user decide.
    const hasRestricted = (list || []).some(c =>
        RESTRICTED_STATUSES.has(c.status),
    )
    if (!hasRestricted) {
        log(
            `getCoupons: ${list?.length || 0} coupons, none restricted — skipping classify-cart`,
        )
        return list
    }
    log(
        `getCoupons: restricted coupon(s) present — classifying cart for insights`,
    )
    const cat = await classifyCartCategory()
    // 3) Annotate restricted coupons with cart category so the popup can render
    //    a contextual "may not apply — your cart is X" hint.
    if (cat?.primary) {
        return list.map(c =>
            RESTRICTED_STATUSES.has(c.status)
                ? {
                      ...c,
                      cartCategory: cat.primary,
                      cartCategorySecondary: cat.secondary,
                  }
                : c,
        )
    }
    return list
}
