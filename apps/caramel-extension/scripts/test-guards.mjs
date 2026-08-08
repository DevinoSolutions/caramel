/**
 * Real-browser proof of the apply flow and its bad-config safety guards.
 *
 * WHY THIS IS NOT A UNIT TEST. The two failure modes these guards exist to
 * prevent — inventing a savings figure the user never received, and clicking a
 * checkout's order button because a scraped selector pointed there — both live
 * in code the unit suite cannot reach. savings-plausibility.test.mjs stubs
 * applyCoupon out entirely; scripts/test-extension.mjs drives applyCoupon
 * directly against a synthetic page and never renders the injected UI. Neither
 * runs the real content-script bundle, in a real layout engine, through the
 * real service-worker message plumbing, against a real store config. Running it
 * that way on 2026-08-04 found two defects nothing else had: a discount
 * measuring as exactly zero on a cart whose total visibly dropped, and a
 * stalled stylesheet fetch that silently suppressed every injected surface.
 *
 * SAFETY. The store origin is fully route-intercepted and the caramel API is
 * stubbed inside the service worker: not one request leaves for either host. No
 * cart is created and no order is placed anywhere. The store config is a frozen
 * snapshot of what production serves (tests/fixtures/naturepedic-store-config.json).
 *
 * Run: pnpm test:guards            (source tree)
 *      CARAMEL_EXT_DIR=./dist pnpm test:guards   (the packaged build)
 */

import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXT = resolve(process.env.CARAMEL_EXT_DIR || ROOT)
const STORE = 'naturepedic.com'
const CART_URL = `https://${STORE}/checkout/cart/`
const ONLY = process.argv[2] || null

// Several checks below assert on the extension's own diagnostic markers
// (AUTO_INSERT_BASELINE_NARROWED / _REFUSED_CONTROL / _EARLY_EXIT), which come
// out of log() — silent in a build stamped for production, by design, so our
// internals never print into a shopper's store console. Say so up front
// instead of letting three checks fail for a reason nothing on screen
// explains. (Before the environment became a build-time stamp, a packaged
// directory ran verbose by accident: it carries no manifest update_url, and
// the old heuristic read that as "an unpacked dev install" — the exact bug the
// stamp replaced.)
const stampPath = join(EXT, 'caramel-env.js')
const stamp = existsSync(stampPath) ? readFileSync(stampPath, 'utf8') : ''
if (stamp.includes('isProduction: true')) {
    console.error(
        `\n  This suite needs a development-stamped package: ${EXT} is stamped for production,\n` +
            `  so log() is a no-op and the diagnostic-marker checks cannot pass.\n\n` +
            `  Build one:  node scripts/build-dist.mjs --env=development --out=dist-guards\n` +
            `  Then run:   CARAMEL_EXT_DIR=./dist-guards pnpm test:guards\n`,
    )
    process.exit(1)
}

const STORE_CONFIG = JSON.parse(
    readFileSync(
        join(ROOT, 'tests/fixtures/naturepedic-store-config.json'),
        'utf8',
    ),
)
const COUPONS = [
    { id: 'c1', code: 'SAVE12', discount: '12%', status: 'valid' },
    { id: 'c2', code: 'SECOND10', discount: '10%', status: 'valid' },
    { id: 'c3', code: 'THIRD5', discount: '5%', status: 'valid' },
    { id: 'c4', code: 'FOURTH1', discount: '1%', status: 'valid' },
]

const results = []
const check = (name, ok, detail = '') => {
    results.push({ name, ok, detail })
    console.log(
        `  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`,
    )
}

/* A Magento-class cart built to the fixture's OWN selectors: #coupon_code
 * behind the #block-discount-heading accordion, an apply button, .message-error,
 * a cancel-coupon row for successIndicator, and a .grand.totals .price total.
 * `behaviour` decides how the fake checkout answers a code. */
const pageHtml = behaviour => `<!doctype html><html><head><meta charset=utf-8>
<title>Cart</title><style>
body{font-family:system-ui;padding:24px}
#discount-coupon-form{display:none}
#discount-coupon-form.open{display:block}
.message-error{display:none;color:#b00}
.message-error.on{display:block}
.grand.totals{font-size:20px;margin:18px 0}
button{padding:8px 14px}
</style></head><body>
<h1>Shopping Cart</h1>
<div class="grand totals"><span class="price">$<span id="total-num">120.00</span>${
    // A strikethrough MSRP INSIDE the element the config's price selector
    // resolves to — the shape that made a real $12 discount measure as zero.
    behaviour === 'msrp-banner' ? ' <s>$500.00</s>' : ''
}</span></div>
${
    // late-reveal: the promo entry is NOT in the DOM at load — a user action
    // inserts it later, the way Shopify Checkout One's collapsed order summary
    // behaves (proven live on 100percentpure.com, 2026-08-05). Every other
    // behaviour ships the block statically, exactly as before.
    behaviour === 'late-reveal'
        ? `<button id="reveal-promo">Show order summary</button>
<div id="promo-slot"></div>
<template id="promo-tpl">
<div class="discount">
  <div id="block-discount-heading" role="button">Apply Promo Code</div>
  <form id="discount-coupon-form">
    <input type="text" id="coupon_code" name="coupon_code" placeholder="Enter code"/>
    <button type="button" data-action="apply-coupon">Apply Discount</button>
    <div class="message-error"></div>
    <div id="applied-slot"></div>
  </form>
</div>
</template>`
        : `<div class="discount">
  <div id="block-discount-heading" role="button">Apply Promo Code</div>
  <form id="discount-coupon-form">
    <input type="text" id="coupon_code" name="coupon_code" placeholder="Enter code"/>
    <button type="button" data-action="apply-coupon">Apply Discount</button>
    <div class="message-error"></div>
    <div id="applied-slot"></div>
  </form>
</div>`
}
<button id="place-order-btn" aria-label="Place Order">Place Order</button>
<script>
window.__orderPlaced = false
window.__applyClicks = 0
window.__codesSeen = []
const BEHAVIOUR = ${JSON.stringify(behaviour)}
document.getElementById('place-order-btn').addEventListener('click', () => {
    window.__orderPlaced = true
})
function bindPromo() {
    document.getElementById('block-discount-heading').addEventListener('click', () => {
        document.getElementById('discount-coupon-form').classList.add('open')
    })
    document.querySelector('[data-action="apply-coupon"]').addEventListener('click', () => {
        window.__applyClicks++
        const code = document.getElementById('coupon_code').value
        window.__codesSeen.push(code)
        if (BEHAVIOUR === 'silent') return
        if (BEHAVIOUR === 'reject-all') {
            setTimeout(() => {
                const err = document.querySelector('.message-error')
                err.textContent = 'The coupon code "' + code + '" is not valid.'
                err.classList.add('on')
            }, 250)
            return
        }
        // The first code works. Only the total moves; an MSRP stays put.
        setTimeout(() => {
            document.getElementById('total-num').textContent = '108.00'
            document.getElementById('applied-slot').innerHTML =
                '<button type="button" data-action="cancel-coupon">Cancel Coupon</button>'
        }, 300)
    })
}
if (BEHAVIOUR === 'late-reveal') {
    document.getElementById('reveal-promo').addEventListener('click', () => {
        document.getElementById('promo-slot').appendChild(
            document.getElementById('promo-tpl').content.cloneNode(true))
        bindPromo()
    })
} else {
    bindPromo()
}
</script></body></html>`

/** The real config with one deliberate lie: the apply selector resolved to the
 *  checkout's order button — the most expensive way a scraped config is wrong. */
const doctoredConfig = () => ({
    ...STORE_CONFIG,
    couponSubmit: '#place-order-btn',
})

/** Replaces fetch INSIDE the service worker. Routing the worker's own requests
 *  through Playwright proved unreliable (it would sometimes issue no network at
 *  all), and a catch-all page route also intercepts chrome-extension:// loads —
 *  including the stylesheet every injected surface awaits — which stalls the UI
 *  and looks exactly like a product bug. */
const REPORTS_KEY = '__caramel_test_reports'
const stubApi = (sw, config) =>
    sw.evaluate(
        ([cfg, coupons, reportsKey]) => {
            if (globalThis.__caramelStubbed) return
            globalThis.__caramelStubbed = true
            const realFetch = globalThis.fetch
            const json = body =>
                Promise.resolve(
                    new Response(JSON.stringify(body), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' },
                    }),
                )
            // Recorded in storage, NOT on a worker global: an idle MV3 worker
            // is killed and restarted, and the discount-link path reloads the
            // page mid-flow. A global would make "the report never fired" and
            // "the worker was recycled" look identical, which is exactly the
            // distinction this suite has to be able to draw.
            //
            // Appends are SERIALIZED. reportOutcome fires its report and its
            // increment back to back, so two concurrent read-modify-writes both
            // read the empty list and the second overwrites the first — which
            // reads as "the report never fired" and sent me chasing a product
            // bug that was this recorder's own race.
            let queue = Promise.resolve()
            const record = entry => {
                queue = queue.then(
                    () =>
                        new Promise(done =>
                            chrome.storage.local.get([reportsKey], res => {
                                const list = res?.[reportsKey] || []
                                list.push(entry)
                                chrome.storage.local.set(
                                    { [reportsKey]: list },
                                    done,
                                )
                            }),
                        ),
                )
            }
            /* Serializing the appends fixed their ORDER, not their arrival.
             * record() returns immediately, so a scenario could finish, read
             * the key, and see [] while the write was still in flight — which
             * is indistinguishable from "the report never fired" and is the
             * flake that failed this suite for anyone running it more than
             * once: `fires the "worked" trust-loop report: []` came up in 4 of
             * 7 runs on 2026-08-06, on unrelated branches, with and without the
             * change under test — which is how it was finally pinned on the
             * harness. Nothing was wrong with the product; a guard that cries
             * wolf about the money path is its own defect, because the next
             * real failure gets shrugged at.
             *
             * The reader awaits this before it looks. */
            globalThis.__caramelReportsSettled = () => queue
            globalThis.fetch = (input, init) => {
                const u = String(typeof input === 'string' ? input : input.url)
                if (u.includes('/api/extension/supported-stores'))
                    return json({ supported: [cfg] })
                if (/\/api\/coupons\/[^/]+\/report/.test(u)) {
                    record({ kind: 'report', body: init?.body || '' })
                    return json({ ok: true })
                }
                if (u.includes('/api/coupons/increment')) {
                    record({ kind: 'increment' })
                    return json({ ok: true })
                }
                if (u.includes('/api/coupons'))
                    return json({ coupons, total: coupons.length })
                return realFetch(input, init)
            }
        },
        [config, COUPONS, REPORTS_KEY],
    )

async function runScenario({
    name,
    behaviour,
    doctor = false,
    cart = null,
    lateReveal = false,
    assert,
}) {
    console.log(`\n=== ${name} ===`)
    const ctx = await chromium.launchPersistentContext(
        mkdtempSync(join(tmpdir(), 'caramel-guard-')),
        {
            // MV3 service workers need a headed browser; on CI this runs under
            // xvfb, the same way scripts/test-extension.mjs does.
            headless: false,
            args: [
                `--disable-extensions-except=${EXT}`,
                `--load-extension=${EXT}`,
            ],
            viewport: { width: 1280, height: 900 },
        },
    )
    try {
        /* Server-side cart state for the discount-link scenarios. coupon-apply
         * detects that strategy by CAPABILITY, not by store list: /cart.js must
         * answer with {token, total_price, item_count} and /discount/{code}
         * must attach the code to the session. Scenarios without a `cart` 404
         * the probe, which is how every non-Shopify store answers, and the DOM
         * form path runs instead. */
        const cartState = cart ? { ...cart.initial } : null
        const discountsSeen = []

        await ctx.route(`https://${STORE}/**`, route => {
            const url = new URL(route.request().url())
            if (/^\/cart\.js$/.test(url.pathname)) {
                return cartState
                    ? route.fulfill({
                          status: 200,
                          contentType: 'application/json',
                          body: JSON.stringify(cartState),
                      })
                    : route.fulfill({ status: 404, body: 'not found' })
            }
            const discount = url.pathname.match(/^\/discount\/(.+)$/)
            if (discount && cartState) {
                const code = decodeURIComponent(discount[1])
                discountsSeen.push(code)
                // Only the winning code moves the session's total, exactly as
                // the real endpoint behaves: a later code replaces an earlier.
                if (code === cart.winner)
                    cartState.total_price = cart.discounted
                return route.fulfill({
                    status: 200,
                    contentType: 'text/html; charset=utf-8',
                    body: 'ok',
                })
            }
            return route.fulfill({
                status: 200,
                contentType: 'text/html; charset=utf-8',
                body: pageHtml(behaviour),
            })
        })

        const config = doctor ? doctoredConfig() : STORE_CONFIG
        let sw =
            ctx.serviceWorkers()[0] ||
            (await ctx.waitForEvent('serviceworker', { timeout: 30_000 }))
        await stubApi(sw, config)
        // An idle MV3 worker is killed and replaced; re-stub every replacement
        // so a restart mid-flow cannot let a real request through.
        ctx.on('serviceworker', w => stubApi(w, config).catch(() => {}))

        const page = await ctx.newPage()
        const logs = []
        const errors = []
        page.on('console', m => {
            const t = m.text()
            if (t.startsWith('Caramel:')) logs.push(t)
            // The /cart.js 404 above is this harness's own doing.
            if (m.type() === 'error' && !/404/.test(t))
                errors.push(t.slice(0, 200))
        })
        page.on('pageerror', e =>
            errors.push('pageerror: ' + String(e).slice(0, 200)),
        )

        await page.goto(CART_URL, {
            waitUntil: 'domcontentloaded',
            timeout: 45_000,
        })
        // A brand-new profile can commit a navigation before the just-loaded
        // extension's content scripts are registered, and that page never gets
        // them. One reload settles it; anything failing after that is real.
        await page.waitForTimeout(2500)
        if (!logs.length) {
            console.log(
                '  [info] content script absent on first load — reloading once',
            )
            await page.reload({ waitUntil: 'domcontentloaded' })
        }

        if (lateReveal) {
            // isCheckout waits 3s for the configured selectors, and the
            // re-detect observer is debounced — give both room to have
            // definitively NOT fired before calling the page dark.
            await page.waitForTimeout(7000)
            check(
                'stays dark while the promo entry is not in the DOM',
                !(await page.$('#caramel-small-prompt')),
            )
            await page.click('#reveal-promo')
        }
        await page.waitForSelector('#caramel-small-prompt', {
            state: 'attached',
            timeout: 30_000,
        })
        check(
            lateReveal
                ? 'prompt appears the moment the promo entry is inserted'
                : 'prompt appears on a supported checkout',
            true,
            doctor ? 'doctored config' : 'production config',
        )

        await page.click('#caramel-small-prompt')
        await page.waitForSelector('#caramel-final-overlay', {
            timeout: 60_000,
        })
        await page.waitForTimeout(500) // let the shadow tree paint its copy

        // The shadow root also holds the injected <style> sheets; reading its
        // raw textContent returns the CSS rather than what the user sees.
        const modal = await page.evaluate(() => {
            const root = document.getElementById(
                'caramel-final-overlay',
            )?.shadowRoot
            if (!root) return ''
            return [...root.children]
                .filter(el => el.tagName !== 'STYLE' && el.tagName !== 'LINK')
                .map(el => el.innerText || el.textContent || '')
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim()
        })
        const state = await page.evaluate(() => ({
            orderPlaced: window.__orderPlaced,
            applyClicks: window.__applyClicks,
            codesSeen: window.__codesSeen,
        }))
        // Extension storage is unreachable from the page's main world.
        sw = ctx.serviceWorkers()[0] || sw
        const savings = await sw.evaluate(
            () =>
                new Promise(res =>
                    chrome.storage.local.get(['caramel_savings'], r =>
                        res(r?.caramel_savings || []),
                    ),
                ),
        )
        // Drain the recorder before reading, then give a straggler two more
        // chances: a report fired microseconds after the first drain would
        // otherwise read as one that never fired. Bounded, so a genuinely
        // missing report still fails the check rather than hanging it.
        let reports = []
        for (let attempt = 0; attempt < 3; attempt++) {
            reports = await sw.evaluate(async key => {
                await globalThis.__caramelReportsSettled?.()
                return new Promise(res =>
                    chrome.storage.local.get([key], r => res(r?.[key] || [])),
                )
            }, REPORTS_KEY)
            if (reports.length) break
            await new Promise(r => setTimeout(r, 250))
        }

        console.log(`  [modal] ${modal.slice(0, 200)}`)
        console.log(
            `  [page ] orderPlaced=${state.orderPlaced} applyClicks=${state.applyClicks} codes=${JSON.stringify(state.codesSeen)}`,
        )
        console.log(`  [saved] ${JSON.stringify(savings)}`)
        if (cartState)
            console.log(
                `  [cart ] total=${cartState.total_price} discountsTried=${JSON.stringify(discountsSeen)}`,
            )
        check(
            'no page errors during the flow',
            errors.length === 0,
            errors.slice(0, 2).join(' | '),
        )
        assert({
            modal,
            state,
            savings,
            logs,
            reports,
            cartState,
            discountsSeen,
            check,
        })
    } finally {
        await ctx.close()
    }
}

const SCENARIOS = [
    {
        name: 'S1 happy path — production config, first code works',
        behaviour: 'happy',
        assert: ({ modal, state, savings, reports, check }) => {
            check(
                'reveals the collapsed accordion and reaches the box',
                state.applyClicks > 0,
                `${state.applyClicks} apply click(s)`,
            )
            check(
                'types the first code',
                state.codesSeen[0] === 'SAVE12',
                JSON.stringify(state.codesSeen),
            )
            check(
                'reports the true $12.00 saving',
                /12\.00/.test(modal),
                modal.slice(0, 90),
            )
            check(
                'banks exactly one measured saving',
                savings.length === 1 &&
                    Math.abs(savings[0]?.amount - 12) < 0.01,
                JSON.stringify(savings),
            )
            check(
                'fires the "worked" trust-loop report',
                reports.some(
                    r => r.kind === 'report' && /worked/.test(r.body || ''),
                ),
                JSON.stringify(reports.map(r => r.kind)),
            )
            check('never touches the order button', state.orderPlaced === false)
        },
    },
    {
        name: 'S2 savings-integrity guard — a $500 MSRP shares the price container',
        behaviour: 'msrp-banner',
        assert: ({ modal, savings, logs, check }) => {
            check(
                'does not claim the $392 the largest number would give',
                !/392/.test(modal),
                modal.slice(0, 120),
            )
            check(
                'claims the defensible $12.00 instead',
                /12\.00/.test(modal),
                modal.slice(0, 120),
            )
            check(
                'does not under-report it to zero either',
                !/hasn.t changed the total/i.test(modal),
                modal.slice(0, 120),
            )
            check(
                'banks $12',
                savings.length === 1 &&
                    Math.abs(savings[0]?.amount - 12) < 0.01,
                JSON.stringify(savings),
            )
            check(
                'logs that it narrowed the baseline',
                logs.some(l => l.includes('AUTO_INSERT_BASELINE_NARROWED')),
            )
        },
    },
    {
        name: 'S3 forbidden-control guard — config points couponSubmit at "Place Order"',
        behaviour: 'happy',
        doctor: true,
        assert: ({ state, savings, logs, reports, check }) => {
            check(
                'REFUSES to click the order button',
                state.orderPlaced === false,
                `orderPlaced=${state.orderPlaced}`,
            )
            check(
                'logs the refusal',
                logs.some(l => l.includes('AUTO_INSERT_REFUSED_CONTROL')),
            )
            check(
                'banks no savings from a refused flow',
                savings.length === 0,
                JSON.stringify(savings),
            )
            check(
                'blames no coupon for our own bad config',
                !reports.some(r => r.kind === 'report'),
                JSON.stringify(reports.map(r => r.kind)),
            )
        },
    },
    {
        name: 'S4 store rejects every code — honest fallback',
        behaviour: 'reject-all',
        assert: ({ modal, savings, reports, check }) => {
            check(
                "quotes the store's own words",
                /not valid/i.test(modal),
                modal.slice(0, 140),
            )
            check('offers the codes to copy manually', /SAVE12/.test(modal))
            check(
                'banks nothing',
                savings.length === 0,
                JSON.stringify(savings),
            )
            check(
                'reports a real failure (the store gave a reason)',
                reports.some(
                    r => r.kind === 'report' && /failed/.test(r.body || ''),
                ),
                JSON.stringify(reports.map(r => r.kind)),
            )
        },
    },
    {
        name: 'S5 silent checkout — no signal at all',
        behaviour: 'silent',
        assert: ({ state, savings, logs, reports, check }) => {
            check(
                'early-exits instead of grinding every code',
                state.applyClicks <= 2,
                `${state.applyClicks} apply click(s)`,
            )
            check(
                'logs the early exit',
                logs.some(l => l.includes('AUTO_INSERT_EARLY_EXIT')),
            )
            check(
                'banks nothing',
                savings.length === 0,
                JSON.stringify(savings),
            )
            check(
                'blames NO coupon when the checkout said nothing',
                !reports.some(r => r.kind === 'report'),
                JSON.stringify(reports.map(r => r.kind)),
            )
        },
    },
    /* The discount-link strategy is the path MOST supported stores actually
     * take — a Shopify-class checkout whose Apply button is isTrusted-gated, so
     * the DOM form is deaf and coupon-apply falls back to /discount/{code} plus
     * live /cart.js totals. It also owns the only reload in the flow: a win
     * reloads the page so the store's own UI shows the discount, and the result
     * modal is re-shown on the fresh document from a sessionStorage handoff.
     * None of that had ever been exercised. */
    {
        name: 'S6 discount-link strategy — the DOM form is never touched',
        behaviour: 'silent', // the form would do nothing even if it were used
        cart: {
            initial: {
                token: 'c1-test-token',
                total_price: 12000,
                item_count: 2,
                currency: 'USD',
                items: [],
            },
            winner: 'SECOND10',
            discounted: 10800,
        },
        assert: ({ modal, state, savings, discountsSeen, reports, check }) => {
            check(
                'probes codes over the discount endpoint',
                discountsSeen.length > 0,
                JSON.stringify(discountsSeen),
            )
            check(
                'never falls back to the deaf DOM form',
                state.applyClicks === 0,
                `${state.applyClicks} apply click(s)`,
            )
            check(
                'stops at the code that moved the cart',
                discountsSeen[discountsSeen.length - 1] === 'SECOND10',
                JSON.stringify(discountsSeen),
            )
            check(
                'survives its own reload and re-shows the result',
                /12\.00/.test(modal),
                modal.slice(0, 120),
            )
            check(
                'banks the cents-accurate $12.00',
                savings.length === 1 &&
                    Math.abs(savings[0]?.amount - 12) < 0.01,
                JSON.stringify(savings),
            )
            check(
                'credits the winning code, not the first one tried',
                savings[0]?.code === 'SECOND10',
                JSON.stringify(savings),
            )
            check(
                'fires the "worked" report before the reload unloads us',
                reports.some(
                    r => r.kind === 'report' && /worked/.test(r.body || ''),
                ),
                JSON.stringify(reports.map(r => r.kind)),
            )
        },
    },
    {
        name: 'S7 discount-link strategy — no code moves the total',
        behaviour: 'silent',
        cart: {
            initial: {
                token: 'c2-test-token',
                total_price: 12000,
                item_count: 2,
                currency: 'USD',
                items: [],
            },
            winner: null, // nothing works
            discounted: 12000,
        },
        assert: ({ modal, state, savings, discountsSeen, reports, check }) => {
            check(
                'tries every code it was given',
                discountsSeen.length === COUPONS.length,
                JSON.stringify(discountsSeen),
            )
            check(
                'does not then also grind the DOM form',
                state.applyClicks === 0,
                `${state.applyClicks} apply click(s)`,
            )
            check(
                'hands the codes over to copy instead',
                /SAVE12/.test(modal),
                modal.slice(0, 120),
            )
            check(
                'banks nothing',
                savings.length === 0,
                JSON.stringify(savings),
            )
            check(
                'blames no coupon — a silent cart is not a rejection',
                !reports.some(r => r.kind === 'report'),
                JSON.stringify(reports.map(r => r.kind)),
            )
        },
    },
    /* Found live via the chrome-devtools MCP on 100percentpure.com
     * (2026-08-05): Checkout One renders the discount input inside a COLLAPSED
     * order summary, so at load the configured selectors match nothing and the
     * page must stay dark — no prompt over a checkout the user can't see a
     * promo box on. Expanding the summary inserts the field, and the re-detect
     * MutationObserver has to surface the prompt then, on the same document,
     * with no navigation. That expand-then-prompt flow ended in a real $9.00
     * saving the store's own UI confirmed — this pins the path that won it. */
    {
        name: 'S8 late reveal — promo entry inserted after load',
        behaviour: 'late-reveal',
        lateReveal: true,
        assert: ({ modal, state, savings, reports, check }) => {
            check(
                'runs the full apply flow on the late field',
                state.applyClicks > 0,
                `${state.applyClicks} apply click(s)`,
            )
            check(
                'reports the true $12.00 saving',
                /12\.00/.test(modal),
                modal.slice(0, 90),
            )
            check(
                'banks exactly one measured saving',
                savings.length === 1 &&
                    Math.abs(savings[0]?.amount - 12) < 0.01,
                JSON.stringify(savings),
            )
            check(
                'fires the "worked" trust-loop report',
                reports.some(
                    r => r.kind === 'report' && /worked/.test(r.body || ''),
                ),
                JSON.stringify(reports.map(r => r.kind)),
            )
            check('never touches the order button', state.orderPlaced === false)
        },
    },
]

console.log(`extension under test: ${EXT}`)
for (const scenario of SCENARIOS) {
    if (ONLY && !scenario.name.startsWith(ONLY)) continue
    try {
        await runScenario(scenario)
    } catch (err) {
        check(`${scenario.name} — harness`, false, String(err).slice(0, 200))
    }
}

const failed = results.filter(r => !r.ok)
console.log(
    `\n${results.length - failed.length}/${results.length} checks passed.`,
)
if (failed.length) {
    console.log('FAILED:')
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
    process.exit(1)
}
