#!/usr/bin/env node
/**
 * Automated extension test suite.
 *
 * Launches Chromium with the unpacked extension loaded, checks:
 *   1. Background service worker boots and detects dev mode → localhost:58000
 *   2. Extension login via /api/extension/login succeeds
 *   3. /api/extension/supported-stores returns XPath-configured stores
 *   4. Supported store sample has valid selectors
 *   5. Coupons endpoint reachable
 *   6. Popup UI: fills the login form and verifies logged-in state
 *   7. Injection logic: loads shared-utils.js against a fake store DOM and
 *      verifies applyCoupon() finds the input, fills the code, and clicks apply.
 *
 * Prereqs:
 *   - caramel-app dev server running on localhost:58000 (pnpm dev)
 *   - Test user test@caramel.dev / test1234 exists
 *
 * Run: pnpm -C apps/caramel-extension test:e2e
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const EXT_PATH = path.resolve(__dirname, '..')
const API_BASE = 'http://localhost:58000'
const TEST_EMAIL = 'test@caramel.dev'
const TEST_PASSWORD = 'test1234'
const EXTENSION_API_KEY = 'WXqEpm2uOV5jjJXPpnQFyZiNdaPVUrtd2LIrf4kc1JA'

const results = []
function log(step, ok, detail = '') {
    const icon = ok ? '✓' : '✗'
    console.log(`${icon} ${step}${detail ? ' — ' + detail : ''}`)
    results.push({ step, ok, detail })
}

async function waitForServiceWorker(context, timeout = 15000) {
    const start = Date.now()
    while (Date.now() - start < timeout) {
        const sw = context.serviceWorkers()[0]
        if (sw) return sw
        await new Promise(r => setTimeout(r, 200))
    }
    return null
}

async function main() {
    console.log(`[test] extension path: ${EXT_PATH}`)
    console.log(`[test] api base: ${API_BASE}`)

    const userDataDir = path.join(
        process.env.TEMP || '/tmp',
        `caramel-ext-test-${Date.now()}`,
    )
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        channel: 'chromium',
        args: [
            `--disable-extensions-except=${EXT_PATH}`,
            `--load-extension=${EXT_PATH}`,
            '--no-first-run',
        ],
    })

    try {
        // 1. Service worker boots
        const sw = await waitForServiceWorker(context)
        log('service worker booted', !!sw, sw ? sw.url() : 'timeout')
        if (!sw) throw new Error('Background service worker never started')

        const extensionId = new URL(sw.url()).host

        // 2. Dev-mode URL switch
        await new Promise(r => setTimeout(r, 1500))
        const baseUrl = await sw.evaluate(() => globalThis.CARAMEL_BASE_URL)
        log(
            'dev-mode URL switch',
            baseUrl === API_BASE,
            `CARAMEL_BASE_URL=${baseUrl}`,
        )

        // 3. Direct API login
        const loginRes = await sw.evaluate(
            async ({ url, email, password }) => {
                const r = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password }),
                })
                return {
                    status: r.status,
                    body: await r.json().catch(() => null),
                }
            },
            {
                url: `${API_BASE}/api/extension/login`,
                email: TEST_EMAIL,
                password: TEST_PASSWORD,
            },
        )
        log(
            'extension login API',
            loginRes.status === 200 && loginRes.body?.token,
            `status=${loginRes.status} user=${loginRes.body?.username || 'n/a'}`,
        )

        // 4. Supported stores
        const storesRes = await sw.evaluate(
            async ({ url, key }) => {
                const r = await fetch(url, { headers: { 'x-api-key': key } })
                return {
                    status: r.status,
                    body: await r.json().catch(() => null),
                }
            },
            {
                url: `${API_BASE}/api/extension/supported-stores`,
                key: EXTENSION_API_KEY,
            },
        )
        const storeCount = storesRes.body?.supported?.length ?? 0
        log(
            'supported-stores endpoint',
            storesRes.status === 200 && storeCount > 0,
            `status=${storesRes.status} count=${storeCount}`,
        )

        // 5. Sample has XPath
        const sample = storesRes.body?.supported?.[0]
        log(
            'sample store has XPath',
            !!(sample?.couponInput && sample?.couponSubmit),
            sample ? `${sample.domain}` : 'no sample',
        )

        // 6. Coupons endpoint
        const couponsRes = await sw.evaluate(
            async ({ url, key }) => {
                const r = await fetch(url, { headers: { 'x-api-key': key } })
                return {
                    status: r.status,
                    body: await r.json().catch(() => null),
                }
            },
            {
                url: `${API_BASE}/api/coupons?site=${encodeURIComponent(sample?.domain || 'allbirds.com')}`,
                key: EXTENSION_API_KEY,
            },
        )
        log(
            'coupons endpoint',
            couponsRes.status === 200,
            `status=${couponsRes.status}`,
        )

        // 7. POPUP UI LOGIN FLOW
        {
            // Clear storage.sync so popup starts logged out (popup.js uses storage.sync)
            await sw.evaluate(
                () =>
                    new Promise(res =>
                        chrome.storage.sync.remove(['token', 'user'], res),
                    ),
            )

            const popup = await context.newPage()
            await popup.goto(`chrome-extension://${extensionId}/index.html`)
            await popup.waitForLoadState('domcontentloaded')
            await popup.waitForTimeout(800)

            const hasLoginToggle =
                (await popup.locator('#loginToggleBtn').count()) > 0
            if (hasLoginToggle) await popup.locator('#loginToggleBtn').click()

            await popup.waitForSelector('#email', { timeout: 5000 })
            await popup.fill('#email', TEST_EMAIL)
            await popup.fill('#password', TEST_PASSWORD)
            await popup.locator('#loginForm button[type="submit"]').click()

            let uiLoggedIn = false
            try {
                await popup.waitForSelector('#logoutBtn', { timeout: 10000 })
                uiLoggedIn = true
            } catch {
                /* fall through */
            }

            // Give storage.sync a moment to flush
            await popup.waitForTimeout(500)
            const stored = await sw.evaluate(
                () =>
                    new Promise(res =>
                        chrome.storage.sync.get(['token', 'user'], res),
                    ),
            )
            log(
                'popup UI login',
                uiLoggedIn && !!stored.token,
                `ui=${uiLoggedIn} token=${stored.token ? 'set' : 'missing'} user=${stored.user?.username || 'n/a'}`,
            )

            await popup.close()
        }

        // 8. DOM INJECTION — real applyCoupon() against a synthetic supported-store DOM
        {
            const sharedUtilsSrc = readFileSync(
                path.join(EXT_PATH, 'shared-utils.js'),
                'utf8',
            )

            const page = await context.newPage()
            // about:blank has no CSP so we can freely inject via page.evaluate
            await page.goto('about:blank')
            await page.setContent(`<!doctype html><html><body>
                <div class="price" id="total">$100.00</div>
                <input id="coupon-field" type="text" />
                <button id="apply-btn">Apply</button>
            </body></html>`)

            // Wire click handler and load shared-utils.js via evaluate (bypasses CSP)
            await page.evaluate(utilsSrc => {
                window.__clickLog = []
                document
                    .getElementById('apply-btn')
                    .addEventListener('click', () => {
                        window.__clickLog.push({
                            code: document.getElementById('coupon-field').value,
                        })
                        document.getElementById('total').textContent = '$90.00'
                    })
                // Stub chrome APIs that shared-utils.js touches at module scope
                // Force-overwrite: Chromium provides `chrome` on about:blank but without .runtime
                window.chrome = {
                    runtime: {
                        id: 'test-stub',
                        onMessage: { addListener: () => {} },
                        sendMessage: (_msg, cb) => {
                            if (cb) cb({})
                            return Promise.resolve({})
                        },
                    },
                    storage: { sync: { get: (_, cb) => cb && cb({}) } },
                }
                ;(0, eval)(utilsSrc)
            }, sharedUtilsSrc)

            const rec = {
                domain: 'test-store.local',
                couponInput: '#coupon-field',
                couponSubmit: '#apply-btn',
                priceContainer: '.price',
            }

            const result = await page.evaluate(async rec => {
                const out = await applyCoupon('SAVE10', rec)
                return {
                    result: out,
                    inputValue: document.getElementById('coupon-field').value,
                    clicks: window.__clickLog,
                    finalPrice: document.getElementById('total').textContent,
                }
            }, rec)

            const filledCorrectly = result.inputValue === 'SAVE10'
            const clicked =
                result.clicks.length === 1 && result.clicks[0].code === 'SAVE10'
            log(
                'applyCoupon() fills input',
                filledCorrectly,
                `value="${result.inputValue}"`,
            )
            log(
                'applyCoupon() clicks apply',
                clicked,
                `clicks=${JSON.stringify(result.clicks)}`,
            )
            log(
                'applyCoupon() detects price change',
                result.result?.success === true,
                `final=${result.finalPrice} newTotal=${result.result?.newTotal}`,
            )

            await page.close()
        }
    } finally {
        await context.close()
    }

    const failed = results.filter(r => !r.ok)
    console.log(
        `\n=== Summary: ${results.length - failed.length}/${results.length} passed ===`,
    )
    if (failed.length) {
        console.log('FAILED:')
        for (const f of failed) console.log(`  - ${f.step}: ${f.detail}`)
        process.exit(1)
    }
}

main().catch(err => {
    console.error('FATAL:', err)
    process.exit(1)
})
