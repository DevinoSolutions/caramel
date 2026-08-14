// Shared fixture for the ext-probe suites — same role as _load.mjs: a helper
// beside the tests, not a test itself (no `.test.mjs` suffix, so vitest's
// include glob leaves it alone).

/**
 * A run where every one of the seven GREEN evidence items is present.
 * Pass section-shaped overrides to knock exactly one leg out, so each test
 * states the single fact it is about.
 */
export function greenObservation(overrides = {}) {
    const base = {
        seed: {
            ok: true,
            detail: 'added Towel / 42',
            rejectedAdds: 0,
            adds: 1,
        },
        platform: {
            detected: 'shopify',
            productFeedOk: true,
            cartApiOk: true,
            productsJsonOk: true,
            cartJsOk: true,
        },
        cartItemsAtArrival: 1,
        config: {
            servedFromApi: true,
            cacheClearedBeforeRun: true,
            expected: { couponInput: '#code' },
            served: { couponInput: '#code' },
            matches: true,
            mismatchedFields: [],
        },
        detection: { checkoutViaCartPayload: true, matchedPromoBox: true },
        coupons: { fetchStarted: true, fetchEnded: true, count: 7 },
        prompt: {
            present: true,
            appearedMs: 6200,
            rect: { w: 300, h: 81 },
            opacity: '1',
            visibility: 'visible',
            cssIsFallback: false,
            shadowChildren: 1,
        },
        indicators: {
            priceContainer: '.totals__subtotal-value',
            successIndicator: '.cart-discount',
            errorIndicator: '.field__message--error',
        },
        apply: {
            submitted: 2,
            successFiredOnGoodCode: true,
            errorFiredOnInvalidCode: true,
            totalBefore: 11100,
            totalAfter: 9990,
        },
    }
    for (const [section, patch] of Object.entries(overrides)) {
        base[section] =
            patch && typeof patch === 'object' && !Array.isArray(patch)
                ? { ...base[section], ...patch }
                : patch
    }
    return base
}

/** The mirror image: a run that never got a cart, so nothing downstream counts. */
export function seedFailedObservation(overrides = {}) {
    return greenObservation({
        seed: {
            ok: false,
            detail: 'no add accepted after 5 tries (last 429) — stopping before we rate-limit the store',
            rejectedAdds: 5,
            adds: 5,
        },
        cartItemsAtArrival: 0,
        detection: { checkoutViaCartPayload: false, matchedPromoBox: false },
        coupons: { fetchStarted: false, fetchEnded: false, count: null },
        prompt: {
            present: false,
            appearedMs: null,
            rect: null,
            opacity: null,
            visibility: null,
            cssIsFallback: null,
            shadowChildren: null,
        },
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
        ...overrides,
    })
}
