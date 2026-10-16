/**
 * Real-browser proof that the promo-box auto-detect (the finder for stores
 * with no config, and the server's pick behind it) never makes the extension
 * worse than it was before it existed.
 *
 * Runs the real built extension in Chromium, the same way
 * scripts/test-guards.mjs does: every store origin is route-intercepted and
 * the caramel API is stubbed inside the service worker, so not one request
 * leaves for a store or for caramel. No cart is created and no order is placed
 * anywhere. The two feature flags (`couponBoxDiscovery`, `couponBoxLlm`) and
 * the pick endpoint are stubbed per scenario.
 *
 *   A  configured store, both flags ON   -> exactly the configured flow: the
 *                                           true saving, no pick asked, no box
 *                                           marked by the finder
 *   B  no config, both flags OFF         -> no prompt, no pick asked
 *   C  no config, a box the rules find   -> the true saving, no pick asked
 *   D  no config, a box only the server
 *      can name                          -> one pick asked, the true saving
 *   E  no config, a wrong pick (an email
 *      field and a link out of the cart) -> the codes to copy, no saving,
 *                                           never left the cart
 *   F  no config, no box at all          -> the codes to copy, no saving
 *   G  no config, a server-named box where
 *      the store SAYS "applied" but the
 *      total never moves                 -> no saving, no "worked" report
 *   H  no config, a labelled box that
 *      applies on Enter (no button), the
 *      server names none                 -> the codes to copy, nothing pressed
 *   I  no config, a box only the server
 *      can name, applies on Enter        -> one pick asked, Enter pressed,
 *                                           the true saving
 *   J  no config, a box the rules find in
 *      a cart that reloads per code      -> both codes tried across the
 *                                           reloads, the true saving of the
 *                                           one that worked
 *   L  no config, a points "Apply
 *      discount" button and no coupon
 *      box, the server names it as the
 *      reveal                            -> nothing clicked, the codes to copy
 *   K  as J, but a box only the server
 *      can name                          -> skipped unless the build keeps a
 *                                           server pick across a reload
 *                                           (CARAMEL_AUTODETECT_KEPT_PICK=1)
 *
 * Run: pnpm test:autodetect          (default: .output/chrome-mv3-dev)
 *      CARAMEL_EXT_DIR=<dir> pnpm test:autodetect
 *      pnpm test:autodetect D        (one scenario, by its letter)
 */

import { execSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_EXT = join(ROOT, '.output', 'chrome-mv3-dev')
const EXT = resolve(process.env.CARAMEL_EXT_DIR || DEFAULT_EXT)
const ONLY = process.argv[2] || null

if (EXT === DEFAULT_EXT && !existsSync(join(EXT, 'manifest.json'))) {
    console.log('[autodetect] building .output/chrome-mv3-dev (dev stamp)…')
    execSync('npx wxt build --mode development', {
        cwd: ROOT,
        stdio: 'inherit',
        shell: true,
    })
}

const CONFIG = JSON.parse(
    readFileSync(
        join(ROOT, 'tests/fixtures/naturepedic-store-config.json'),
        'utf8',
    ),
)
const COUPONS = [
    { id: 'c1', code: 'SAVE20', discount: '20%', status: 'valid' },
    { id: 'c2', code: 'TENOFF', discount: '10%', status: 'valid' },
]
const RECORD_KEY = '__caramel_test_calls'

const results = []
const check = (name, ok, detail = '') => {
    results.push({ name, ok, detail })
    console.log(
        `  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`,
    )
}

const SHELL = body => `<!doctype html><html><head><meta charset=utf-8>
<title>Cart</title><style>
body{font-family:system-ui;padding:24px}
.hidden{display:none}
#discount-coupon-form{display:none}
#discount-coupon-form.open{display:block}
.message-error{display:none;color:#b00}
.message-error.on{display:block}
button,a{padding:8px 14px}
</style></head><body><h1>Shopping Cart</h1>${body}
<button id="place-order-btn" aria-label="Place Order">Place Order</button>
<script>
window.__orderPlaced = false
window.__submits = []
document.getElementById('place-order-btn').addEventListener('click', () => {
    window.__orderPlaced = true
})
</script></body></html>`

/* The configured store, built to the fixture's own selectors: the box sits
 * behind the #block-discount-heading accordion, and the first code takes $12
 * off a $120 cart. */
const CONFIGURED_PAGE = SHELL(`
<div class="grand totals"><span class="price">$<span id="total-num">120.00</span></span></div>
<div class="discount">
  <div id="block-discount-heading" role="button">Apply Promo Code</div>
  <form id="discount-coupon-form">
    <input type="text" id="coupon_code" name="coupon_code"/>
    <button type="button" data-action="apply-coupon">Apply Discount</button>
    <div class="message-error"></div>
    <div id="applied-slot"></div>
  </form>
</div>
<script>
document.getElementById('block-discount-heading').addEventListener('click', () =>
    document.getElementById('discount-coupon-form').classList.add('open'))
document.querySelector('[data-action="apply-coupon"]').addEventListener('click', () => {
    window.__submits.push(document.getElementById('coupon_code').value)
    setTimeout(() => {
        document.getElementById('total-num').textContent = '108.00'
        document.getElementById('applied-slot').innerHTML =
            '<button type="button" data-action="cancel-coupon">Cancel Coupon</button>'
    }, 300)
})
</script>`)

/* A store with no config. `box` is the markup of its promo box (or nothing);
 * the input `#in` and the button `#btn` answer the way a cart does: SAVE20
 * takes $20 off, anything else is refused. With `saysYes` the store prints
 * "applied" for every code and the total never moves. */
const finderPage = (box, saysYes = false) =>
    SHELL(`
<div class="row"><span>Total</span> <span id="tot">$100.00</span></div>
${box}
<script>
const btn = document.getElementById('btn')
const SAYS_YES = ${saysYes}
btn && btn.addEventListener('click', e => {
    if (btn.tagName === 'A') return
    const code = document.getElementById('in').value
    window.__submits.push(code)
    setTimeout(() => {
        const note = document.createElement('div')
        if (SAYS_YES) {
            note.textContent = 'Coupon ' + code + ' applied!'
        } else if (code === 'SAVE20') {
            document.getElementById('tot').textContent = '$80.00'
            note.textContent = 'Discount applied'
        } else {
            note.textContent = 'Sorry, ' + code + ' is not a valid code.'
        }
        btn.parentElement.appendChild(note)
    }, 200)
})
</script>`)

// Recognised by the finder's own rules: a labelled discount-code field.
const RULES_BOX =
    '<div class="promo"><label for="in">Discount code</label>' +
    '<input id="in" name="discount_code" type="text">' +
    '<button id="btn" type="button">Apply</button></div>'
// Recognised by no rule: only the server's pick can name it.
const BARE_BOX =
    '<div class="f"><input id="in" name="field_7" type="text">' +
    '<button id="btn" type="button">Go</button></div>'
// The wrong things a bad pick could name: a newsletter email field and a link
// out of the cart labelled "Apply".
const WRONG_BOX =
    '<div class="news"><input id="in" name="newsletter" type="email">' +
    '<a id="btn" href="/checkout/next">Apply</a></div>'

// A loyalty panel and no coupon box: "Apply discount" spends the shopper's
// points. A click on it is recorded on the page.
const POINTS_PAGE = SHELL(`
<div class="row"><span>Total</span> <span id="tot">$100.00</span></div>
<div class="loyalty"><p>You have 500 points</p>
<button id="spend" type="button">Apply discount</button></div>
<script>
window.__spent = false
document.getElementById('spend').addEventListener('click', () => {
    window.__spent = true
    document.getElementById('tot').textContent = '$95.00'
})
</script>`)

// Boxes that apply on Enter: no button at all. The page answers the keydown
// the way such carts do. The rules recognise the labelled one; only the
// server's pick can name the bare one.
const enterPage = labelled =>
    SHELL(`
<div class="row"><span>Total</span> <span id="tot">$100.00</span></div>
<div class="promo">${
        labelled
            ? '<label for="in">Discount code</label><input id="in" name="discount_code" type="text">'
            : '<input id="in" name="field_7" type="text">'
    }</div>
<script>
const input = document.getElementById('in')
input.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return
    const code = input.value
    window.__submits.push('enter:' + code)
    setTimeout(() => {
        const note = document.createElement('div')
        if (code === 'SAVE20') {
            document.getElementById('tot').textContent = '$80.00'
            note.textContent = 'Discount applied'
        } else {
            note.textContent = 'Sorry, ' + code + ' is not a valid code.'
        }
        input.parentElement.appendChild(note)
    }, 200)
})
</script>`)

/* A cart that posts its discount form and reloads the whole page after every
 * code, the way Magento 2's couponPost does. The cart lives on the "server"
 * (this closure): SAVE20 is refused, TENOFF takes $10 off, and the reloaded
 * page says so. `labelled` gives the rules a box they recognise; without it
 * only the server's pick can name the box. `posts` records every code the
 * store received. */
function reloadingCart(labelled) {
    const posts = []
    let applied = null
    let note = ''
    const field = labelled ? 'discount_code' : 'field_7'
    const serve = request => {
        if (request.method() === 'POST') {
            const code =
                new URLSearchParams(request.postData() || '').get(field) || ''
            posts.push(code)
            if (code === 'TENOFF') {
                applied = code
                note = 'Discount applied'
            } else note = 'Sorry, ' + code + ' is not a valid code.'
        }
        const box = labelled
            ? '<label for="in">Discount code</label><input id="in" name="discount_code" type="text">' +
              '<button id="btn" type="submit">Apply</button>'
            : '<input id="in" name="field_7" type="text">' +
              '<button id="btn" type="submit">Go</button>'
        return SHELL(`
<div class="row"><span>Total</span> <span id="tot">$${applied ? '90.00' : '100.00'}</span></div>
<form method="post" action="/cart" class="promo">${box}<div class="note">${note}</div></form>`)
    }
    return { posts, serve }
}

/* Replaces fetch inside the service worker (see test-guards.mjs for why the
 * worker's own requests are not routed through Playwright). Every pick request
 * and every coupon report is recorded in extension storage, behind a
 * serialized queue the reader drains first. `pickPlan` scripts the server:
 * `{ input, button, toggle }` are regex sources matched against the outline's lines,
 * and the answer names the index on the first matching line. */
const stubApi = (sw, opts) =>
    sw.evaluate(
        ([o, coupons, key]) => {
            if (globalThis.__caramelStubbed) return
            globalThis.__caramelStubbed = true
            const json = body =>
                Promise.resolve(
                    new Response(JSON.stringify(body), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' },
                    }),
                )
            let queue = Promise.resolve()
            const record = entry => {
                queue = queue.then(
                    () =>
                        new Promise(done =>
                            chrome.storage.local.get([key], res => {
                                const list = res?.[key] || []
                                list.push(entry)
                                chrome.storage.local.set({ [key]: list }, done)
                            }),
                        ),
                )
            }
            globalThis.__caramelCallsSettled = () => queue
            const indexOn = (outline, source) => {
                if (!source) return null
                const re = new RegExp(source)
                const line = String(outline || '')
                    .split('\n')
                    .find(l => re.test(l))
                const m = line && /\[(\d+)\]/.exec(line)
                return m ? Number(m[1]) : null
            }
            globalThis.fetch = (input, init) => {
                const u = String(typeof input === 'string' ? input : input.url)
                if (u.includes('/api/extension/features')) {
                    record({ kind: 'features' })
                    return json({
                        shopperCodeCapture: false,
                        couponBoxDiscovery: o.flags,
                        couponBoxLlm: o.flags,
                    })
                }
                if (u.includes('/api/extension/coupon-box-pick')) {
                    const body = JSON.parse(init?.body || '{}')
                    record({ kind: 'pick', domain: body.domain })
                    const plan = o.pickPlan
                    if (!plan)
                        return json({
                            outcome: 'no_box',
                            confidence: 90,
                            why: 'none',
                            cached: false,
                        })
                    return json({
                        outcome: 'box',
                        input: indexOn(body.outline, plan.input),
                        button: indexOn(body.outline, plan.button),
                        toggle: indexOn(body.outline, plan.toggle),
                        confidence: 90,
                        why: 'scripted',
                        cached: false,
                    })
                }
                if (u.includes('/api/extension/supported-stores'))
                    return json({ supported: [o.config] })
                if (/\/api\/coupons\/[^/]+\/report/.test(u)) {
                    record({ kind: 'report', body: init?.body || '' })
                    return json({ ok: true })
                }
                if (u.includes('/api/coupons/increment'))
                    return json({ ok: true })
                if (u.includes('/api/coupons'))
                    return json({ coupons, total: coupons.length })
                // Nothing else may reach the network from this suite.
                record({ kind: 'unexpected', url: u })
                return Promise.resolve(new Response('', { status: 404 }))
            }
        },
        [opts, COUPONS, RECORD_KEY],
    )

async function runScenario({
    name,
    host,
    path,
    page: html,
    serve = null,
    flags,
    pickPlan = null,
    expectPrompt = true,
    assert,
}) {
    console.log(`\n=== ${name} ===`)
    const ctx = await chromium.launchPersistentContext(
        mkdtempSync(join(tmpdir(), 'caramel-autodetect-')),
        {
            headless: false,
            args: [
                `--disable-extensions-except=${EXT}`,
                `--load-extension=${EXT}`,
            ],
            viewport: { width: 1280, height: 900 },
        },
    )
    try {
        const storeRequests = []
        await ctx.route(`https://${host}/**`, route => {
            const url = new URL(route.request().url())
            storeRequests.push(url.pathname)
            // Every non-Shopify store answers the cart probe like this.
            if (url.pathname.endsWith('/cart.js'))
                return route.fulfill({ status: 404, body: 'not found' })
            return route.fulfill({
                status: 200,
                contentType: 'text/html; charset=utf-8',
                body: serve ? serve(route.request()) : html,
            })
        })

        const opts = { flags, pickPlan, config: CONFIG }
        let sw =
            ctx.serviceWorkers()[0] ||
            (await ctx.waitForEvent('serviceworker', { timeout: 30_000 }))
        await stubApi(sw, opts)
        ctx.on('serviceworker', w => stubApi(w, opts).catch(() => {}))

        const page = await ctx.newPage()
        const logs = []
        const errors = []
        const navigations = []
        page.on('console', m => {
            const t = m.text()
            if (t.startsWith('Caramel:')) logs.push(t)
            if (m.type() === 'error' && !/404/.test(t))
                errors.push(t.slice(0, 200))
        })
        page.on('pageerror', e =>
            errors.push('pageerror: ' + String(e).slice(0, 200)),
        )
        page.on('framenavigated', f => {
            if (f === page.mainFrame()) navigations.push(f.url())
        })

        const url = `https://${host}${path}`
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
        await page.waitForTimeout(2500)
        if (!logs.length) {
            console.log(
                '  [info] content script absent on first load — reloading once',
            )
            await page.reload({ waitUntil: 'domcontentloaded' })
        }

        let modal = ''
        if (expectPrompt) {
            await page.waitForSelector('#caramel-small-prompt', {
                state: 'attached',
                timeout: 30_000,
            })
            check('the prompt appears', true)
            await page.click('#caramel-small-prompt')
            await page.waitForSelector('#caramel-final-overlay', {
                timeout: 90_000,
            })
            await page.waitForTimeout(500)
            modal = await page.evaluate(() => {
                const root = document.getElementById(
                    'caramel-final-overlay',
                )?.shadowRoot
                if (!root) return ''
                return [...root.children]
                    .filter(el => !/^(STYLE|LINK)$/.test(el.tagName))
                    .map(el => el.innerText || el.textContent || '')
                    .join(' ')
                    .replace(/\s+/g, ' ')
                    .trim()
            })
        } else {
            // isCheckout waits up to 3s for a box, and the re-detect observer
            // is debounced: give both room to have definitively not fired.
            await page.waitForTimeout(8000)
            check('no prompt appears', !(await page.$('#caramel-small-prompt')))
        }

        const state = await page.evaluate(() => ({
            orderPlaced: window.__orderPlaced,
            submits: window.__submits,
            url: location.href,
            found: document.querySelectorAll('[data-caramel-found]').length,
            testingOverlayUp: !!document
                .getElementById('caramel-testing-overlay')
                ?.checkVisibility?.(),
            alertShim: document.documentElement.hasAttribute(
                'data-caramel-alert-shim',
            ),
            spent: window.__spent === true,
        }))
        sw = ctx.serviceWorkers()[0] || sw
        const savings = await sw.evaluate(
            () =>
                new Promise(res =>
                    chrome.storage.local.get(['caramel_savings'], r =>
                        res(r?.caramel_savings || []),
                    ),
                ),
        )
        let calls = []
        for (let attempt = 0; attempt < 3; attempt++) {
            calls = await sw.evaluate(async key => {
                await globalThis.__caramelCallsSettled?.()
                return new Promise(res =>
                    chrome.storage.local.get([key], r => res(r?.[key] || [])),
                )
            }, RECORD_KEY)
            await new Promise(r => setTimeout(r, 250))
        }
        const picks = calls.filter(c => c.kind === 'pick')
        const worked = calls.filter(
            c => c.kind === 'report' && /worked/.test(c.body || ''),
        )

        console.log(`  [modal] ${modal.slice(0, 200)}`)
        console.log(
            `  [page ] submits=${JSON.stringify(state.submits)} url=${state.url} found=${state.found}`,
        )
        console.log(`  [saved] ${JSON.stringify(savings)}`)
        console.log(`  [calls] ${JSON.stringify(calls.map(c => c.kind))}`)

        check(
            'no page errors during the flow',
            errors.length === 0,
            errors.slice(0, 2).join(' | '),
        )
        check(
            'nothing outside the stubbed API was requested',
            !calls.some(c => c.kind === 'unexpected'),
            JSON.stringify(calls.filter(c => c.kind === 'unexpected')),
        )
        check('never touches the order button', state.orderPlaced === false)
        check(
            'never leaves the cart',
            state.url === url &&
                navigations.every(n => n === url) &&
                storeRequests.every(p => p === path || p.endsWith('/cart.js')),
            JSON.stringify({ navigations, storeRequests }),
        )
        check('no testing overlay is left up', state.testingOverlayUp === false)
        check(
            'the porkbun alert shim is not injected here',
            state.alertShim === false,
        )
        assert({ modal, state, savings, picks, worked })
    } finally {
        await ctx.close()
    }
}

const SCENARIOS = [
    {
        name: 'A configured store, both flags on — exactly the configured flow',
        host: CONFIG.domain,
        path: '/checkout/cart/',
        page: CONFIGURED_PAGE,
        flags: true,
        // A pick plan that would name the box: if the finder were consulted it
        // would succeed, so the "no pick" check below cannot pass by accident.
        pickPlan: { input: 'textbox', button: 'button "Apply Discount"' },
        assert: ({ modal, state, savings, picks, worked }) => {
            check(
                'types the first code into the configured box',
                state.submits[0] === 'SAVE20',
                JSON.stringify(state.submits),
            )
            check('reports the true $12.00 saving', /12\.00/.test(modal))
            check(
                'banks exactly that saving',
                savings.length === 1 &&
                    Math.abs(savings[0]?.amount - 12) < 0.01,
                JSON.stringify(savings),
            )
            check('fires one "worked" report', worked.length === 1)
            check('never asks the server for a pick', picks.length === 0)
            check('the finder marks nothing', state.found === 0)
        },
    },
    {
        name: 'B no config, flags off — nothing changes',
        host: 'shop-with-a-box.example',
        path: '/cart',
        page: finderPage(RULES_BOX),
        flags: false,
        expectPrompt: false,
        assert: ({ state, savings, picks }) => {
            check('never asks the server for a pick', picks.length === 0)
            check('types nothing', state.submits.length === 0)
            check('banks nothing', savings.length === 0)
            check('the finder marks nothing', state.found === 0)
        },
    },
    {
        name: 'C no config, a box the rules find — the true saving',
        host: 'shop-with-a-box.example',
        path: '/cart',
        page: finderPage(RULES_BOX),
        flags: true,
        assert: ({ modal, state, savings, picks, worked }) => {
            check(
                'types SAVE20 into the found box',
                state.submits[0] === 'SAVE20',
                JSON.stringify(state.submits),
            )
            check('reports the true $20.00 saving', /20\.00/.test(modal))
            check(
                'banks exactly that saving',
                savings.length === 1 &&
                    Math.abs(savings[0]?.amount - 20) < 0.01,
                JSON.stringify(savings),
            )
            check('fires one "worked" report', worked.length === 1)
            check('never asks the server for a pick', picks.length === 0)
        },
    },
    {
        name: 'D no config, a box only the server can name — the true saving',
        host: 'shop-with-a-bare-box.example',
        path: '/cart',
        page: finderPage(BARE_BOX),
        flags: true,
        pickPlan: { input: 'textbox', button: 'button "Go"' },
        assert: ({ modal, state, savings, picks, worked }) => {
            check(
                'asks the server once',
                picks.length === 1,
                JSON.stringify(picks),
            )
            check(
                'types SAVE20 into the named box',
                state.submits[0] === 'SAVE20',
                JSON.stringify(state.submits),
            )
            check('reports the true $20.00 saving', /20\.00/.test(modal))
            check(
                'banks exactly that saving',
                savings.length === 1 &&
                    Math.abs(savings[0]?.amount - 20) < 0.01,
                JSON.stringify(savings),
            )
            check('fires one "worked" report', worked.length === 1)
        },
    },
    {
        name: 'E no config, a wrong pick — the codes to copy',
        host: 'shop-with-a-wrong-pick.example',
        path: '/cart',
        page: finderPage(WRONG_BOX),
        flags: true,
        pickPlan: { input: 'email|textbox', button: 'link "Apply"' },
        assert: ({ modal, state, savings, picks, worked }) => {
            check('asks the server once', picks.length === 1)
            check(
                'types nothing anywhere',
                state.submits.length === 0,
                JSON.stringify(state.submits),
            )
            check(
                'hands over the codes to copy',
                /SAVE20/.test(modal) && /TENOFF/.test(modal),
                modal.slice(0, 120),
            )
            check('banks nothing', savings.length === 0)
            check('fires no "worked" report', worked.length === 0)
        },
    },
    {
        name: 'F no config, no box at all — the codes to copy',
        host: 'shop-with-no-box.example',
        path: '/cart',
        page: finderPage(''),
        flags: true,
        assert: ({ modal, state, savings, picks, worked }) => {
            check('asks the server once', picks.length === 1)
            check('types nothing', state.submits.length === 0)
            check(
                'hands over the codes to copy',
                /SAVE20/.test(modal) && /TENOFF/.test(modal),
                modal.slice(0, 120),
            )
            check('banks nothing', savings.length === 0)
            check('fires no "worked" report', worked.length === 0)
        },
    },
    {
        name: 'G no config, the store says "applied" but the total never moves — no saving',
        host: 'shop-that-says-yes.example',
        path: '/cart',
        page: finderPage(BARE_BOX, true),
        flags: true,
        pickPlan: { input: 'textbox', button: 'button "Go"' },
        assert: ({ modal, state, savings, picks, worked }) => {
            check('asks the server once', picks.length === 1)
            check(
                'tries the codes in the named box',
                state.submits.length > 0,
                JSON.stringify(state.submits),
            )
            check(
                'claims no saving',
                !/YOU SAVED/i.test(modal),
                modal.slice(0, 120),
            )
            check('banks nothing', savings.length === 0)
            check('fires no "worked" report', worked.length === 0)
        },
    },
    {
        // The rules never type into a box with no button to confirm it: a
        // field named "Discount code" alone is not enough. Such a box is used
        // only when the server names it (I). When the server says no box,
        // this page ends exactly where it did before the finder existed.
        name: 'H no config, a box the rules see but that applies on Enter, the server names none — the codes to copy',
        host: 'shop-with-an-enter-box.example',
        path: '/cart',
        page: enterPage(true),
        flags: true,
        assert: ({ modal, state, savings, picks, worked }) => {
            check('asks the server once', picks.length === 1)
            check(
                'presses nothing anywhere',
                state.submits.length === 0,
                JSON.stringify(state.submits),
            )
            check(
                'hands over the codes to copy',
                /SAVE20/.test(modal) && /TENOFF/.test(modal),
                modal.slice(0, 120),
            )
            check('banks nothing', savings.length === 0)
            check('fires no "worked" report', worked.length === 0)
        },
    },
    {
        name: 'I no config, a box only the server can name that applies on Enter — the true saving',
        host: 'shop-with-a-bare-enter-box.example',
        path: '/cart',
        page: enterPage(false),
        flags: true,
        // The server names the input and no button.
        pickPlan: { input: 'textbox', button: null },
        assert: ({ modal, state, savings, picks, worked }) => {
            check(
                'asks the server once',
                picks.length === 1,
                JSON.stringify(picks),
            )
            check(
                'presses Enter with SAVE20 in the named box',
                state.submits[0] === 'enter:SAVE20',
                JSON.stringify(state.submits),
            )
            check('reports the true $20.00 saving', /20\.00/.test(modal))
            check(
                'banks exactly that saving',
                savings.length === 1 &&
                    Math.abs(savings[0]?.amount - 20) < 0.01,
                JSON.stringify(savings),
            )
            check('fires one "worked" report', worked.length === 1)
        },
    },
    (() => {
        const cart = reloadingCart(true)
        return {
            name: 'J no config, a box the rules find in a cart that reloads per code — the true saving',
            host: 'shop-that-reloads.example',
            path: '/cart',
            serve: cart.serve,
            flags: true,
            assert: ({ modal, savings, picks, worked }) => {
                check(
                    'the store received both codes, one per reload',
                    JSON.stringify(cart.posts) ===
                        JSON.stringify(['SAVE20', 'TENOFF']),
                    JSON.stringify(cart.posts),
                )
                check('reports the true $10.00 saving', /10\.00/.test(modal))
                check(
                    'banks exactly that saving',
                    savings.length === 1 &&
                        Math.abs(savings[0]?.amount - 10) < 0.01,
                    JSON.stringify(savings),
                )
                check('fires one "worked" report', worked.length === 1)
                check('never asks the server for a pick', picks.length === 0)
            },
        }
    })(),
    {
        name: 'L no config, a points "Apply discount" and no coupon box, the server names it as the reveal — nothing clicked',
        host: 'shop-with-points.example',
        path: '/cart',
        page: POINTS_PAGE,
        flags: true,
        // If the reveal were clicked the points would be spent (and the total
        // would drop by $5, which no code did).
        pickPlan: {
            input: null,
            button: null,
            toggle: 'button "Apply discount"',
        },
        assert: ({ modal, state, savings, worked }) => {
            check('never clicks the points button', state.spent === false)
            check(
                'hands over the codes to copy',
                /SAVE20/.test(modal) && /TENOFF/.test(modal),
                modal.slice(0, 120),
            )
            check('banks nothing', savings.length === 0)
            check('fires no "worked" report', worked.length === 0)
        },
    },
    (() => {
        const cart = reloadingCart(false)
        return {
            name: 'K no config, a box only the server can name in a cart that reloads per code — the true saving',
            // A server pick is not kept across a reload on main: the rules see
            // no box on the reloaded page and the store is never asked twice,
            // so the chain stops after the first code and hands the rest over
            // to copy. Keeping the pick is PR #348's change; this scenario is
            // its proof once it lands.
            skip:
                process.env.CARAMEL_AUTODETECT_KEPT_PICK === '1'
                    ? null
                    : 'this build does not keep a server pick across a reload (PR #348); set CARAMEL_AUTODETECT_KEPT_PICK=1 to run it',
            host: 'shop-that-reloads-a-bare-box.example',
            path: '/cart',
            serve: cart.serve,
            flags: true,
            pickPlan: { input: 'textbox', button: 'button "Go"' },
            assert: ({ modal, savings, picks, worked }) => {
                check(
                    'asks the server once',
                    picks.length === 1,
                    JSON.stringify(picks),
                )
                check(
                    'the store received both codes, one per reload',
                    JSON.stringify(cart.posts) ===
                        JSON.stringify(['SAVE20', 'TENOFF']),
                    JSON.stringify(cart.posts),
                )
                check('reports the true $10.00 saving', /10\.00/.test(modal))
                check(
                    'banks exactly that saving',
                    savings.length === 1 &&
                        Math.abs(savings[0]?.amount - 10) < 0.01,
                    JSON.stringify(savings),
                )
                check('fires one "worked" report', worked.length === 1)
            },
        }
    })(),
]

console.log(`extension under test: ${EXT}`)
const skipped = []
for (const scenario of SCENARIOS) {
    if (ONLY && !scenario.name.startsWith(ONLY)) continue
    if (scenario.skip) {
        console.log(`\n=== ${scenario.name} ===\n  SKIP  ${scenario.skip}`)
        skipped.push(scenario.name)
        continue
    }
    try {
        await runScenario(scenario)
    } catch (err) {
        check(`${scenario.name} — harness`, false, String(err).slice(0, 200))
    }
}

const failed = results.filter(r => !r.ok)
console.log(
    `\n${results.length - failed.length}/${results.length} checks passed.` +
        (skipped.length ? ` ${skipped.length} scenario(s) skipped.` : ''),
)
if (failed.length) {
    console.log('FAILED:')
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
    process.exit(1)
}
