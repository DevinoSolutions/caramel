// owns: DOM visibility/wait helpers, price parsing, CSS/XPath query helpers (_isVisible, waitForVisible, pickBestMatch, waitForElement, waitForTextChange, waitUntilReady, getPrice, _isXPath, qOne, qAll)
// load after: caramel-base.js

/* ---------- DOM waiters ---------- */
/* ---------- visibility helpers ---------- */
// "Can the user actually see this?" — checkVisibility() correctly handles
// display:none ancestors (collapsed accordions), visibility:hidden and
// content-visibility, and (unlike the old offsetParent test) doesn't
// false-negative inside position:fixed/sticky containers, where order-summary
// rails and their coupon UIs commonly live.
function _isVisible(el) {
    if (!el) return false
    try {
        if (typeof el.checkVisibility === 'function')
            return el.checkVisibility()
    } catch {
        /* fall through to the legacy heuristic */
    }
    return el.offsetParent !== null
}
// Wait until the selector matches a VISIBLE element. waitForElement only waits
// for presence — useless for reveal-toggles that unhide pre-rendered markup
// (the input already "exists" while still display:none). Checks ALL matches,
// not just the first: generic selectors often also hit hidden templates.
// Called from other split content-script files (see store-detect.js's
// startCheckoutDetection for why per-file analysis misses cross-file calls).
// oxlint-disable-next-line no-unused-vars
function waitForVisible(sel, timeout = 3000) {
    return new Promise((res, rej) => {
        const t0 = performance.now()
        ;(function poll() {
            if (qAll(sel).some(_isVisible)) return res('visible')
            if (performance.now() - t0 > timeout)
                return rej(`waitForVisible timeout (${sel})`)
            setTimeout(poll, 120)
        })()
    })
}
// Pick the best element among ALL matches of a config selector. Config
// selectors are often generic on purpose (Magento's `.title[data-role=title]`
// matches EVERY accordion section — Estimate Shipping, Gift Cards, the promo
// block…), and querySelector's "first match" can land on a hidden or wrong
// section. Generic disambiguation, no store logic:
//   1. if an anchor is given (usually the coupon input), prefer the match
//      sharing the SMALLEST containing block with it — the promo toggle sits
//      in the same block as the promo input; unrelated accordions don't;
//   2. otherwise prefer a VISIBLE match;
//   3. otherwise fall back to the first match.
// Called from other split content-script files (cross-file content-script
// call — oxlint's per-file analysis can't see it).
// oxlint-disable-next-line no-unused-vars
function pickBestMatch(sel, anchorEl) {
    const all = qAll(sel)
    if (!all.length) return null
    if (anchorEl) {
        let best = null
        let bestDepth = Infinity
        let bestVisible = false
        for (const cand of all) {
            let p = cand.parentElement
            let d = 0
            while (p && d < 8) {
                if (p.contains(anchorEl)) {
                    const v = _isVisible(cand)
                    if (
                        d < bestDepth ||
                        (d === bestDepth && v && !bestVisible)
                    ) {
                        bestDepth = d
                        best = cand
                        bestVisible = v
                    }
                    break
                }
                p = p.parentElement
                d++
            }
        }
        if (best) return best
    }
    return all.find(_isVisible) || all[0]
}
// Called from other split content-script files (cross-file content-script
// call — oxlint's per-file analysis can't see it).
// oxlint-disable-next-line no-unused-vars
function waitForElement(sel, timeout = 4000) {
    return new Promise((res, rej) => {
        if (qOne(sel)) return res('found-immediately')
        const mo = new MutationObserver(() => {
            if (qOne(sel)) {
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
// Called from other split content-script files (cross-file content-script
// call — oxlint's per-file analysis can't see it).
// oxlint-disable-next-line no-unused-vars
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
/* ---------- UI readiness helper ---------- */
// Called from other split content-script files (cross-file content-script
// call — oxlint's per-file analysis can't see it).
// oxlint-disable-next-line no-unused-vars
async function waitUntilReady(rec, timeout = 2000) {
    const btn = qOne(rec.couponSubmit)
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
// Called from other split content-script files (cross-file content-script
// call — oxlint's per-file analysis can't see it).
// oxlint-disable-next-line no-unused-vars
function getPrice(selector, { returnLargest } = {}) {
    let el = qOne(selector)
    if (!el && typeof selector === 'string' && selector.includes('[id=')) {
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

/* --------------------------------------------------  selector helper
 * Configs may store either a CSS selector or an XPath expression. The agent
 * picks whichever uniquely identifies the element on each store. Detect by
 * leading char and dispatch to the right DOM API.
 *   "input#code"           → CSS  → querySelector
 *   "//input[@id='code']"  → XPath → document.evaluate
 *   "(//div)[2]"           → XPath
 */
function _isXPath(sel) {
    if (typeof sel !== 'string' || !sel) return false
    const t = sel.trim()
    return t.startsWith('/') || t.startsWith('(/') || t.startsWith('./')
}
function qOne(sel, root) {
    if (!sel) return null
    root = root || document
    try {
        if (_isXPath(sel)) {
            const res = document.evaluate(
                sel,
                root,
                null,
                XPathResult.FIRST_ORDERED_NODE_TYPE,
                null,
            )
            return res.singleNodeValue
        }
        return root.querySelector(sel)
    } catch {
        return null
    }
}
function qAll(sel, root) {
    if (!sel) return []
    root = root || document
    try {
        if (_isXPath(sel)) {
            const res = document.evaluate(
                sel,
                root,
                null,
                XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
                null,
            )
            const out = []
            for (let i = 0; i < res.snapshotLength; i++)
                out.push(res.snapshotItem(i))
            return out
        }
        return Array.from(root.querySelectorAll(sel))
    } catch {
        return []
    }
}
