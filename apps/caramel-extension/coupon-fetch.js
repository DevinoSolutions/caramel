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
        const resp = await new Promise(res =>
            currentBrowser.runtime.sendMessage(
                { action: 'fetchCoupons', site, kw, category },
                res,
            ),
        )
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

async function classifyCartCategory() {
    try {
        const cs = window.CaramelCartSignals
        if (!cs || typeof cs.collectCartSignals !== 'function') return null
        const signals = await cs.collectCartSignals()
        const result = await new Promise(res =>
            currentBrowser.runtime.sendMessage(
                { action: 'classifyCart', signals },
                res,
            ),
        )
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
    // unpacked dev installs so a #caramel-test link can't make the packed
    // production build fire mock codes against a real store's checkout.
    if (
        _isDevInstall() &&
        location.hash &&
        location.hash.includes('caramel-test')
    ) {
        log('DEV MODE: returning mocked coupons')
        return [{ code: 'TEST10' }, { code: 'TEST20' }, { code: 'TEST30' }]
    }

    // 1) Use the codes already fetched at detection time (cached) — falls back
    //    to a fresh fetch if the cache is cold. Avoids a double network call.
    const list = await getCachedCodes(rec)

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
