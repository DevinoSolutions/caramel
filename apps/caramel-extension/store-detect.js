// owns: supported-store cache, checkout detection, init hook (STORE_CACHE_*, _getCacheTtl, getDomainRecord, _hostMatchesDomain, isCheckout, getCachedCodes, tryInitialize, startCheckoutDetection). NOT _isDevInstall — see F-008 note below.
// load after: caramel-base.js, dom-utils.js
//
// F-008 note: _isDevInstall used to live here (this file owns the rest of
// "dev-install detection" conceptually) but was relocated to
// caramel-base.js — that file's own top-level code calls it immediately at
// load time and needs it defined before that runs (same-script hoisting
// covered this when everything was one file; separate files don't hoist
// backward across each other). _getCacheTtl() below still calls it, from
// inside a function body (deferred), so it doesn't care that the
// definition now lives in an earlier-loading file instead of this one.

/* --------------------------------------------------  config cache */
const STORE_CACHE_KEY = 'caramel_supported_stores'
const STORE_CACHE_PROD_TTL = 60 * 60 * 1000 // 1 hour
const STORE_CACHE_DEV_TTL = 0 // bypass cache when loaded as unpacked dev extension

function _getCacheTtl() {
    return _isDevInstall() ? STORE_CACHE_DEV_TTL : STORE_CACHE_PROD_TTL
}

async function getDomainRecord(domain) {
    if (!getDomainRecord.cache) {
        const ttl = _getCacheTtl()
        // Check chrome.storage.local for a recent cached copy first
        try {
            const stored =
                ttl > 0
                    ? await new Promise(r =>
                          currentBrowser.storage.local.get(
                              [STORE_CACHE_KEY],
                              r,
                          ),
                      )
                    : null
            const entry = stored?.[STORE_CACHE_KEY]
            if (ttl > 0 && entry?.data?.length && Date.now() - entry.ts < ttl) {
                getDomainRecord.cache = entry.data
                log('Loaded supported domains from local cache')
            }
        } catch {
            /* storage read failed, proceed to API */
        }

        // Fetch fresh configs from the backend
        if (!getDomainRecord.cache) {
            try {
                const resp = await new Promise(res =>
                    currentBrowser.runtime.sendMessage(
                        { action: 'fetchSupportedStores' },
                        res,
                    ),
                )
                if (resp?.supported?.length) {
                    getDomainRecord.cache = resp.supported
                    currentBrowser.storage.local.set({
                        [STORE_CACHE_KEY]: {
                            data: resp.supported,
                            ts: Date.now(),
                        },
                    })
                    log('Loaded supported domains from API')
                }
            } catch (e) {
                log('fetchSupportedStores error', e)
            }
        }

        // If API failed, try expired cache as last resort
        if (!getDomainRecord.cache) {
            try {
                const stored = await new Promise(r =>
                    currentBrowser.storage.local.get([STORE_CACHE_KEY], r),
                )
                const entry = stored?.[STORE_CACHE_KEY]
                if (entry?.data?.length) {
                    getDomainRecord.cache = entry.data
                    log('Loaded supported domains from expired cache')
                }
            } catch {
                /* nothing we can do */
            }
        }
    }
    return getDomainRecord.cache?.find(r =>
        _hostMatchesDomain(domain, r.domain),
    )
}
getDomainRecord.cache = null

// Match the active hostname to a supported-store domain. Accept an exact match,
// a real dotted subdomain (www./checkout./secure.<domain>), or a hyphen-prefixed
// checkout host (gapfactory-style `secure-<brand>.gapfactory.com`). Plain
// substring matching (the old behavior) false-matched unrelated hosts —
// `art.com` ⊂ `walmart.com`, `bestbuy.com` ⊂ `notbestbuy.com`, even
// `target.com` ⊂ `evil-target.com.attacker.net` — which would apply the wrong
// store's selectors to an unrelated site. Require a label boundary (start, '.'
// or '-') so only genuine same-site hosts match.
function _hostMatchesDomain(host, domain) {
    if (!host || !domain) return false
    host = String(host).toLowerCase()
    domain = String(domain).toLowerCase()
    if (host === domain) return true
    const i = host.length - domain.length
    if (i <= 0) return false
    if (host.slice(i) !== domain) return false
    const sep = host[i - 1]
    return sep === '.' || sep === '-'
}

/* --------------------------------------------------  checkout detector */
async function isCheckout() {
    const rec = await getDomainRecord(location.hostname)
    if (!rec) return false
    // VISIBLE, not merely present: themes ship hidden coupon markup on
    // non-checkout pages, and some configs point showInput at site-wide
    // controls — the prompt belongs only where the user can actually see a
    // way to enter a code. Same semantics as the re-detection observer.
    const anyVisible = () =>
        [rec.couponInput, rec.showInput]
            .filter(Boolean)
            .some(sel => qAll(sel).some(_isVisible))
    if (anyVisible()) return true
    // Only wait on the selectors the config actually provides — a bare
    // `${null},${null}`/`,${x}` compound is a wasted 3s wait (or a thrown
    // selector that waitForElement just swallows).
    const waitSel = [rec.couponInput, rec.showInput].filter(Boolean).join(',')
    if (waitSel) {
        try {
            await waitForElement(waitSel, 3000)
        } catch (e) {
            log(e)
        }
    }
    return anyVisible()
}

/* Coupon-availability cache — fetched once when a checkout is detected so we
   can decide whether to even show the prompt, and reused by the apply flow
   (no double fetch). Keyed by domain. Guarded var for re-injection safety. */
if (typeof _caramelCodes === 'undefined') {
    var _caramelCodes = null // { domain, list }
}
async function getCachedCodes(rec) {
    if (_caramelCodes && _caramelCodes.domain === rec.domain)
        return _caramelCodes.list
    let list = []
    try {
        list = await fetchCoupons(rec.domain, '', '')
    } catch {
        list = []
    }
    _caramelCodes = {
        domain: rec.domain,
        list: Array.isArray(list) ? list : [],
    }
    return _caramelCodes.list
}

/* --------------------------------------------------  init hook */
async function tryInitialize() {
    if (!(await isCheckout())) return
    const rec = await getDomainRecord(location.hostname)
    if (!rec) return
    // Don't intercept a checkout we have no codes for — only show the prompt
    // when there's actually something to apply ("checkout without code → why the
    // intercept?"). The fetched list is cached for the apply step.
    const codes = await getCachedCodes(rec)
    if (codes.length) await insertCaramelPrompt(rec)
}

/* Entry point. Beyond the one-shot load check, KEEP WATCHING: on SPA / drawer-
   cart stores (allsaints and most SFCC/Shopify sites) the coupon field is
   injected only when the user opens the bag/cart — with no page navigation, so
   a load-time check finds nothing and the user sees nothing even though the
   promo box is right there. Re-detect it: observe the DOM and show the prompt
   the moment the coupon field appears. Debounced + self-disconnects after it
   fires once, so it costs ~nothing and never nags. */
// Called from inject.js (see UI-helpers.js's insertCaramelPrompt for why
// per-file analysis misses cross-file content-script calls).
// oxlint-disable-next-line no-unused-vars
async function startCheckoutDetection() {
    // A discount-link apply reloads the page so the store's own UI shows the
    // applied code; finish that flow on the fresh document by showing the
    // result modal instead of re-prompting.
    try {
        const raw = sessionStorage.getItem('caramel_applied')
        if (raw) {
            sessionStorage.removeItem('caramel_applied')
            const st = JSON.parse(raw)
            if (st && st.code && Date.now() - (st.t || 0) < 120000) {
                let amount = st.saved || 0
                let msg = null
                if (st.currency && st.currency !== 'USD' && amount > 0) {
                    // The built-in savings line renders "$X" — mislabels
                    // non-USD stores. Present the correctly-formatted amount
                    // through the applied-code presentation instead.
                    try {
                        const fmt = new Intl.NumberFormat(undefined, {
                            style: 'currency',
                            currency: st.currency,
                        }).format(amount)
                        msg = `Code ${st.code} saved you ${fmt} — it's applied to your order.`
                        amount = 0
                    } catch {
                        /* unknown currency code — fall back to $ */
                    }
                }
                showFinalModal(amount, st.code, msg)
                return
            }
        }
    } catch {
        /* sessionStorage unavailable — continue with normal detection */
    }
    await tryInitialize()
    if (window.__caramel_checkout_observer) return
    const rec = await getDomainRecord(location.hostname)
    if (!rec) return // not a supported store — don't observe at all
    let scheduled = false
    const _vis = _isVisible
    const recheck = () => {
        scheduled = false
        // Don't re-prompt if the prompt is already up or we're mid-apply.
        if (
            document.getElementById('caramel-small-prompt') ||
            document.getElementById('caramel-testing-overlay') ||
            document.getElementById('caramel-final-overlay')
        )
            return
        // Require the coupon box (or its reveal toggle) to be VISIBLE, not just
        // present — so a hidden, pre-rendered cart drawer doesn't pop the prompt
        // before the user actually opens the cart.
        if (_vis(qOne(rec.couponInput)) || _vis(qOne(rec.showInput))) {
            // Only prompt if we actually have codes for this store (no empty
            // intercept). getCachedCodes is cached, so this is cheap.
            getCachedCodes(rec).then(codes => {
                if (
                    !codes.length ||
                    document.getElementById('caramel-small-prompt') ||
                    document.getElementById('caramel-testing-overlay') ||
                    document.getElementById('caramel-final-overlay')
                )
                    return
                insertCaramelPrompt(rec)
                if (window.__caramel_checkout_observer) {
                    window.__caramel_checkout_observer.disconnect()
                    window.__caramel_checkout_observer = null
                }
            })
        }
    }
    const mo = new MutationObserver(() => {
        if (scheduled) return
        scheduled = true
        setTimeout(recheck, 400)
    })
    // childList catches a freshly-inserted coupon box; attributes catches the
    // equally common SPA case of a pre-rendered box merely revealed via a
    // class/style/hidden toggle (no new node, so childList alone misses it).
    // Both feed the same debounced recheck above — no separate mechanism.
    mo.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden'],
    })
    window.__caramel_checkout_observer = mo
}
