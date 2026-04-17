/********************************************************************
 * Caramel core logic – 2025-06-29  (speed-tuned)
 ********************************************************************/

/* --------------------------------------------------  bootstrap */
// Track script loading to prevent redeclaration errors on multiple loads
if (typeof window !== 'undefined') {
    if (window.__caramel_shared_utils_loaded) {
        // Script already loaded - use existing window.currentBrowser
        // Don't redeclare to avoid errors
    } else {
        window.__caramel_shared_utils_loaded = true

        // First load - create currentBrowser on window
        window.currentBrowser = (() => {
            if (typeof chrome !== 'undefined') return chrome
            if (typeof browser !== 'undefined') return browser
            throw new Error('Browser is not supported!')
        })()
    }
    // Ensure window.currentBrowser exists
    if (!window.currentBrowser) {
        window.currentBrowser = (() => {
            if (typeof chrome !== 'undefined') return chrome
            if (typeof browser !== 'undefined') return browser
            throw new Error('Browser is not supported!')
        })()
    }
    // Create local reference - var allows redeclaration, so this is safe even on second load
    var currentBrowser = window.currentBrowser
} else {
    // Non-window environment (service worker) - safe to declare normally
    var currentBrowser = (() => {
        if (typeof chrome !== 'undefined') return chrome
        if (typeof browser !== 'undefined') return browser
        throw new Error('Browser is not supported!')
    })()
}

/* --------------------------------------------------  tiny helpers */
// Check if already declared to prevent redeclaration errors on script reload
if (typeof sleep === 'undefined') {
    var sleep = ms => new Promise(r => setTimeout(r, ms))
}
if (typeof log === 'undefined') {
    var log = (...a) => console.log('Caramel:', ...a)
}
if (typeof recordTiming === 'undefined') {
    var recordTiming = (event, meta = {}) => {
        try {
            const entry = { event, t: performance.now(), meta }
            if (
                currentBrowser &&
                currentBrowser.storage &&
                currentBrowser.storage.local
            ) {
                currentBrowser.storage.local.get(['caramel_timings'], res => {
                    const arr = (res && res.caramel_timings) || []
                    arr.push(entry)
                    currentBrowser.storage.local.set({ caramel_timings: arr })
                })
            }
        } catch (e) {
            // ignore storage errors
        }
    }
}

const CARAMEL_ALLOWED_ORIGINS = new Set([
    'http://localhost:58300',
    'https://grabcaramel.com',
    'https://dev.grabcaramel.com',
])

/* ---------- DOM waiters ---------- */
function waitForElement(sel, timeout = 4000) {
    return new Promise((res, rej) => {
        if (document.querySelector(sel)) return res('found-immediately')
        const mo = new MutationObserver(() => {
            if (document.querySelector(sel)) {
                mo.disconnect()
                res('appeared')
            }
        })
        mo.observe(document.documentElement, { childList: true, subtree: true })
        setTimeout(() => {
            mo.disconnect()
            rej(`waitForElement timeout (${sel})`)
        }, timeout)
    })
}
function waitForTextChange(el, timeout = 3000) {
    return new Promise((res, rej) => {
        const start = el.textContent
        const mo = new MutationObserver(() => {
            if (el.textContent !== start) {
                mo.disconnect()
                res('text-changed')
            }
        })
        mo.observe(el, { characterData: true, childList: true, subtree: true })
        setTimeout(() => {
            mo.disconnect()
            rej('waitForTextChange timeout')
        }, timeout)
    })
}
function waitForAmazonFetch() {
    return new Promise(resolve => {
        const orig = window.fetch
        window.fetch = (...args) => {
            const [url] = args
            const p = orig(...args)
            if (url.includes('/apply-discount')) {
                p.finally(() => {
                    window.fetch = orig
                    resolve('network-reply')
                })
            }
            return p
        }
    })
}

/* ---------- Amazon helpers (fast scrape without opening a new tab) ---------- */
async function getAmazonCartKeywords() {
    try {
        // 1) try to read from current DOM
        const titles = Array.from(
            document.querySelectorAll('.sc-product-title'),
        )
            .map(el => el.textContent.trim())
            .filter(Boolean)
        if (titles.length) return titles

        // 2) fetch cart HTML same-origin (keeps cookies)
        const r = await fetch('/gp/cart/view.html?ref_=nav_cart', {
            credentials: 'include',
        })
        if (!r.ok) return []
        const html = await r.text()
        const doc = new DOMParser().parseFromString(html, 'text/html')
        const fetched = Array.from(doc.querySelectorAll('.sc-product-title'))
            .map(el => el.textContent.trim())
            .filter(Boolean)
        return fetched
    } catch (e) {
        log('getAmazonCartKeywords error', e)
        return []
    }
}

/* ---------- UI readiness helper (new) ---------- */
async function waitUntilReady(rec, timeout = 2000) {
    const btn = document.querySelector(rec.couponSubmit)
    const start = performance.now()
    return new Promise(resolve => {
        ;(function loop() {
            if (!btn || !btn.disabled) return resolve()
            if (performance.now() - start > timeout) return resolve() // hard fallback
            requestAnimationFrame(loop)
        })()
    })
}

/* --------------------------------------------------  price grabber */
function getPrice(selector, { returnLargest } = {}) {
    let el = document.querySelector(selector)
    if (!el && selector.includes('[id=')) {
        const id = selector.match(/\[id=['"]([^'"]+)['"]\]/)?.[1]
        if (id) el = document.getElementById(id)
    }
    if (!el) {
        log('getPrice: element NOT found', selector)
        return NaN
    }

    const regex = /(?:[A-Z]{1,3}\s?)?[$£€]\s?\d{1,3}(?:,\d{3})*(?:\.\d+)?/g
    const prices = (el.innerText.match(regex) || []).map(t =>
        parseFloat(t.replace(/[^0-9.]/g, '')),
    )
    if (!prices.length) {
        log('getPrice: no price found')
        return NaN
    }
    return returnLargest ? Math.max(...prices) : prices[0]
}

/* --------------------------------------------------  config cache */
const STORE_CACHE_KEY = 'caramel_supported_stores'
const STORE_CACHE_TTL = 60 * 60 * 1000 // 1 hour

async function getDomainRecord(domain) {
    if (!getDomainRecord.cache) {
        // Check chrome.storage.local for a recent cached copy first
        try {
            const stored = await new Promise(r =>
                currentBrowser.storage.local.get([STORE_CACHE_KEY], r),
            )
            const entry = stored?.[STORE_CACHE_KEY]
            if (
                entry?.data?.length &&
                Date.now() - entry.ts < STORE_CACHE_TTL
            ) {
                getDomainRecord.cache = entry.data
                log('Loaded supported domains from local cache')
            }
        } catch (_) {
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
            } catch (_) {
                /* nothing we can do */
            }
        }
    }
    return getDomainRecord.cache?.find(r => domain.includes(r.domain))
}
getDomainRecord.cache = null

/* --------------------------------------------------  checkout detector */
async function isCheckout() {
    const rec = await getDomainRecord(location.hostname)
    if (!rec) return false
    if (
        document.querySelector(rec.couponInput) ||
        document.querySelector(rec.showInput)
    )
        return true
    try {
        await waitForElement(`${rec.couponInput},${rec.showInput}`, 3000)
    } catch (e) {
        log(e)
    }
    return !!(
        document.querySelector(rec.couponInput) ||
        document.querySelector(rec.showInput)
    )
}

/* --------------------------------------------------  init hook */
async function tryInitialize() {
    if (await isCheckout()) {
        const rec = await getDomainRecord(location.hostname)
        await insertCaramelPrompt(rec)
    }
}

/* --------------------------------------------------  coupon attempt */
async function applyCoupon(code, rec) {
    const attemptStart = performance.now()
    log('AUTO_INSERT_ATTEMPT_START', code, { t: attemptStart })
    recordTiming('AUTO_INSERT_ATTEMPT_START', { code })
    try {
        /* 1] dismiss popup if present */
        if (rec.dismissButton) {
            const btn = document.querySelector(rec.dismissButton)
            if (btn) {
                btn.click()
                await sleep(180)
                log('Popup dismissed')
            }
        }

        /* 2] ensure input visible */
        let input = document.querySelector(rec.couponInput)
        if (!input && rec.showInput) {
            const showBtn = document.querySelector(rec.showInput)
            if (showBtn) {
                showBtn.click()
                try {
                    await waitForElement(rec.couponInput, 3000)
                } catch (e) {
                    log(e)
                }
                input = document.querySelector(rec.couponInput)
            }
        }
        const applyBtn = document.querySelector(rec.couponSubmit)
        if (!input || !applyBtn) {
            log('Input / apply button missing')
            log('AUTO_INSERT_ATTEMPT_END', code, {
                success: false,
                elapsed: performance.now() - attemptStart,
            })
            return { success: false }
        }

        const original = getPrice(rec.priceContainer, { returnLargest: true })

        /* 3] fill & click */
        input.value = code
        input.dispatchEvent(new Event('input', { bubbles: true }))
        applyBtn.click()

        /* 4] wait for result */
        const waiters = [sleep(1200).then(() => 'timeout-1.2s')] // shorter fallback
        const priceEl =
            document.querySelector(rec.priceContainer) ||
            document.getElementById(
                rec.priceContainer.match(/\[id=['"]([^'"]+)['"]\]/)?.[1] || '',
            )
        if (priceEl && rec.domain !== 'amazon.com')
            waiters.push(waitForTextChange(priceEl, 3000))
        if (rec.domain === 'amazon.com') waiters.push(waitForAmazonFetch())

        const via = await Promise.race(waiters)
        log('Wait finished via', via)

        const newTotal = getPrice(rec.priceContainer, { returnLargest: true })
        const success = !isNaN(newTotal) && newTotal < original
        const elapsed = performance.now() - attemptStart
        log('AUTO_INSERT_ATTEMPT_END', code, { success, newTotal, elapsed })
        recordTiming('AUTO_INSERT_ATTEMPT_END', {
            code,
            success,
            newTotal,
            elapsed,
        })
        return { success, newTotal }
    } catch (err) {
        console.error('applyCoupon error', err)
        log('AUTO_INSERT_ATTEMPT_END', code, {
            success: false,
            error: String(err),
            elapsed: performance.now() - attemptStart,
        })
        recordTiming('AUTO_INSERT_ATTEMPT_END', {
            code,
            success: false,
            error: String(err),
            elapsed: performance.now() - attemptStart,
        })
        return { success: false }
    }
}

/* --------------------------------------------------  coupon list */
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
async function getCoupons(rec) {
    let kw = ''
    let category = ''
    if (rec.domain === 'amazon.com') {
        // Use fast in-page scrape (or same-origin cart fetch) instead of opening a new tab
        recordTiming('AUTO_INSERT_AMAZON_SCRAPE_REQUEST')
        const titles = await getAmazonCartKeywords()
        recordTiming('AUTO_INSERT_AMAZON_SCRAPE_RESPONSE', {
            count: titles.length,
        })
        kw = (titles || []).join(',')
        log('Amazon keywords', kw)
    }
    // Classify cart category for relevant coupon selection
    try {
        const cs = window.CaramelCartSignals
        if (cs && typeof cs.collectCartSignals === 'function') {
            const signals = await cs.collectCartSignals()
            const result = await new Promise(res =>
                currentBrowser.runtime.sendMessage(
                    { action: 'classifyCart', signals },
                    res,
                ),
            )
            if (result && result.primary && !result.error) {
                category = result.primary
                log(
                    'Cart category:',
                    category,
                    '(conf:',
                    result.confidence,
                    ')',
                )
            }
        }
    } catch (e) {
        log('classifyCart non-fatal error', e)
    }
    // Dev hook: deterministic coupons when using #caramel-test
    if (location.hash && location.hash.includes('caramel-test')) {
        log('DEV MODE: returning mocked coupons')
        return [{ code: 'TEST10' }, { code: 'TEST20' }, { code: 'TEST30' }]
    }
    return fetchCoupons(rec.domain, kw, category)
}

/* --------------------------------------------------  main runner */
async function startApplyingCoupons(rec) {
    log('=== Starting coupon flow ===')
    log('AUTO_INSERT_START', { domain: rec?.domain, t: performance.now() })
    await showTestingModal()

    let coupons
    try {
        coupons = await getCoupons(rec)
    } catch (e) {
        log('AUTO_INSERT_STOP', {
            result: 'coupon-fetch-failed',
            error: String(e),
            t: performance.now(),
        })
        showFinalModal(0, null, 'Network error fetching coupons')
        return
    }
    if (!Array.isArray(coupons) || !coupons.length) {
        log('AUTO_INSERT_STOP', { result: 'no-coupons', t: performance.now() })
        showFinalModal(
            0,
            null,
            'No coupons available for this store right now.',
        )
        return
    }

    // Cap attempts to a reasonable number to limit runtime
    const MAX_ATTEMPTS = 8
    if (coupons.length > MAX_ATTEMPTS) coupons = coupons.slice(0, MAX_ATTEMPTS)

    const original = getPrice(rec.priceContainer, { returnLargest: true })
    let bestSave = 0,
        bestCode = null

    for (let i = 0; i < coupons.length; i++) {
        const { code } = coupons[i]
        await updateTestingModal(i + 1, coupons.length, code)

        const res = await applyCoupon(code, rec)

        /* clear field & wait until UI ready for next pass */
        const inp = document.querySelector(rec.couponInput)
        if (inp) {
            inp.value = ''
            inp.dispatchEvent(new Event('input', { bubbles: true }))
        }
        await waitUntilReady(rec)
        await sleep(120) // tiny visual pause

        if (res.success) {
            const diff = original - res.newTotal
            log(`✓ ${code} saved ${diff}`)
            if (diff > bestSave) {
                bestSave = diff
                bestCode = code
            }
        } else {
            log(`✗ ${code} no savings`)
        }
    }

    if (bestCode) {
        await applyCoupon(bestCode, rec)
        log('AUTO_INSERT_STOP', {
            result: 'applied',
            bestCode,
            bestSave,
            t: performance.now(),
        })
        showFinalModal(
            bestSave,
            bestCode,
            'We found a coupon that saves you money!',
        )
    } else {
        log('AUTO_INSERT_STOP', {
            result: 'none',
            bestCode: null,
            bestSave: 0,
            t: performance.now(),
        })
        showFinalModal(0, null, 'Already the best price.')
    }
}

/* --------------------------------------------------  listeners (unchanged) */
window.addEventListener('message', ev => {
    if (!CARAMEL_ALLOWED_ORIGINS.has(ev.origin)) return
    if (ev.data?.token) {
        currentBrowser.storage.sync.set(
            {
                token: ev.data.token,
                user: {
                    username: ev.data.username || 'CaramelUser',
                    image: ev.data.image,
                },
            },
            tryInitialize,
        )
    }
})
currentBrowser.runtime.onMessage.addListener(async (req, _s, send) => {
    if (req.action === 'userLoggedIn') {
        log('AUTO_INSERT_TRIGGERED_BY_MESSAGE', { t: performance.now() })
        const rec = await getDomainRecord(location.hostname)
        await startApplyingCoupons(rec)
        send({ success: true })
    }
})
