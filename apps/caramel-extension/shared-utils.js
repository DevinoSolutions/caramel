/********************************************************************
 * Caramel core logic – 2025-06-29  (speed-tuned)
 ********************************************************************/

/* --------------------------------------------------  bootstrap */
const currentBrowser = (() => {
    if (typeof chrome !== 'undefined') return chrome
    if (typeof browser !== 'undefined') return browser
    throw new Error('Browser is not supported!')
})()

/* --------------------------------------------------  tiny helpers */
const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = (...a) => console.log('Caramel:', ...a)

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
async function getDomainRecord(domain) {
    if (!getDomainRecord.cache) {
        const r = await fetch(currentBrowser.runtime.getURL('supported.json'))
        const dat = await r.json()
        getDomainRecord.cache = Array.isArray(dat.supported)
            ? dat.supported
            : dat
        log('Loaded supported domains')
    }
    return getDomainRecord.cache.find(r => domain.includes(r.domain))
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
    log('► Trying', code)
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
            return { success: false }
        }

        const original = getPrice(rec.priceContainer, { returnLargest: true })

        /* 3] fill & click */
        input.value = code
        input.dispatchEvent(new Event('input', { bubbles: true }))
        applyBtn.click()

        /* 4] wait for result */
        const waiters = [sleep(3500).then(() => 'timeout-3.5s')] // shorter fallback
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
        return { success: !isNaN(newTotal) && newTotal < original, newTotal }
    } catch (err) {
        console.error('applyCoupon error', err)
        return { success: false }
    }
}

/* --------------------------------------------------  coupon list */
async function fetchCoupons(site, kw) {
    const url = `https://grabcaramel.com/api/coupons?site=${site}&key_words=${encodeURIComponent(kw)}&limit=20`
    try {
        const r = await fetch(url)
        const d = r.ok ? await r.json() : []
        log('Fetched', d.length, 'coupons')
        return d
    } catch (e) {
        log('fetchCoupons error', e)
        return []
    }
}
async function getCoupons(rec) {
    let kw = ''
    if (rec.domain === 'amazon.com') {
        const resp = await new Promise(res =>
            currentBrowser.runtime.sendMessage(
                { action: 'scrapeAmazonCartKeywords' },
                res,
            ),
        )
        kw = (resp?.keywords || []).join(',')
        log('Amazon keywords', kw)
    }
    return fetchCoupons(rec.domain, kw)
}

/* --------------------------------------------------  main runner */
async function startApplyingCoupons(rec) {
    log('=== Starting coupon flow ===')
    await showTestingModal()

    const coupons = await getCoupons(rec)
    if (!coupons.length) {
        showFinalModal(0, null, 'No coupons found.')
        return
    }

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
        showFinalModal(
            bestSave,
            bestCode,
            'We found a coupon that saves you money!',
        )
    } else {
        showFinalModal(0, null, 'Already the best price.')
    }
}

/* --------------------------------------------------  listeners (unchanged) */
window.addEventListener('message', ev => {
    if (ev.origin !== 'https://grabcaramel.com') return
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
        const rec = await getDomainRecord(location.hostname)
        await startApplyingCoupons(rec)
        send({ success: true })
    }
})
