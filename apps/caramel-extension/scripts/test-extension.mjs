#!/usr/bin/env node
/**
 * Automated extension test suite.
 *
 * Launches Chromium with the unpacked extension loaded, checks:
 *   1. Background service worker boots; the PATCHED base URL (see below)
 *      is in effect → localhost:58000
 *   2. Extension login via /api/extension/login succeeds
 *   3. /api/extension/supported-stores returns XPath-configured stores
 *   4. Supported store sample has valid selectors
 *   5. Coupons endpoint reachable
 *   6. Popup UI: fills the login form and verifies logged-in state
 *   7. Injection logic: esbuild-bundles the REAL content-module graph from
 *      the shipped sources (same __CARAMEL_ENV__ define mechanism as the
 *      real build, pointed at the local app), evaluates it against a fake
 *      store DOM, and verifies applyCoupon() finds the input, fills the
 *      code, and clicks apply.
 *
 * Prereqs:
 *   - caramel-app dev server running on localhost:58000 (pnpm dev)
 *   - Test user test@caramel.dev / test1234 exists (email_verified flipped)
 *
 * ⚠️ PATCHED TEST COPY (E-02, reworked for the WXT build in P1): the suite
 * builds `.output/chrome-mv3-dev` (`wxt build --mode development` — the DEV
 * stamp, bundled into the js by the __CARAMEL_ENV__ define), stages a TEMP
 * COPY of that output, and string-replaces the dev deployment URL with
 * localhost:58000 across the copy's bundles. The dev stamp's trustedOrigins
 * already include localhost:58000, so only the baseUrl needs rewriting. A
 * remote target this suite must NOT test against (non-hermetic: races the
 * autodeploy, can't seed users); the replacement count is asserted loudly so
 * an environment-wiring refactor breaks this suite visibly instead of
 * silently testing against the remote deployment. Shipped output untouched.
 *
 * This used to overwrite the copy's caramel-env.js file; there is no such
 * file in the bundled output — the stamp travels inside the bundles.
 *
 * Run: pnpm -C apps/caramel-extension test:e2e
 */

import { build as esbuild } from 'esbuild'
import { execSync } from 'node:child_process'
import {
    cpSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { stampFor } from './environments.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const EXT_PATH = path.resolve(__dirname, '..')
const DEV_OUT = path.join(EXT_PATH, '.output', 'chrome-mv3-dev')
const API_BASE = 'http://localhost:58000'
const DEV_URL = stampFor('development').baseUrl
const TEST_EMAIL = 'test@caramel.dev'
const TEST_PASSWORD = 'test1234'

/**
 * Stages a temp copy of the DEV-stamped WXT output whose baseUrl points at
 * the local app. The stamp is bundled (no caramel-env.js file to overwrite),
 * so the patch is a string replacement across the copy's js, and the suite
 * throws loudly when zero replacements happen — a future refactor of the
 * environment wiring breaks this suite visibly instead of silently testing
 * against the remote deployment.
 */
function stagePatchedExtensionCopy() {
    console.log('[test] building .output/chrome-mv3-dev (dev stamp)…')
    execSync('npx wxt build --mode development', {
        cwd: EXT_PATH,
        stdio: 'inherit',
        shell: true,
    })

    const dest = mkdtempSync(path.join(tmpdir(), 'caramel-ext-patched-'))
    cpSync(DEV_OUT, dest, { recursive: true })

    let replacements = 0
    const walk = dir => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name)
            if (entry.isDirectory()) walk(p)
            else if (entry.name.endsWith('.js')) {
                const src = readFileSync(p, 'utf8')
                if (src.includes(DEV_URL)) {
                    replacements += src.split(DEV_URL).length - 1
                    writeFileSync(p, src.split(DEV_URL).join(API_BASE))
                }
            }
        }
    }
    walk(dest)
    if (replacements === 0) {
        throw new Error(
            `[test] no occurrence of ${DEV_URL} found in the staged dev build — the environment wiring changed; update this patcher deliberately`,
        )
    }
    // The dev stamp already trusts localhost:58000 (scripts/environments.mjs),
    // so only the baseUrl needed rewriting.

    // The shipped manifest grants ONLY https://*/* — a packed extension has no
    // business asking users for access to a localhost dev server (it widens
    // the Web Store install prompt and lets the released build talk to
    // whatever is listening on that port on the user's machine). The local
    // origin is a property of THIS SUITE, so the suite grants it to its own
    // copy, exactly like the base-URL rewrite above.
    const manifestPath = path.join(dest, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (manifest.host_permissions.includes(`${API_BASE}/*`)) {
        throw new Error(
            `[test] ${API_BASE}/* is in the SHIPPED manifest — it must exist only in this test copy; remove it from manifest.json`,
        )
    }
    manifest.host_permissions.push(`${API_BASE}/*`)
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 4))

    console.log(
        `[test] ⚠️ LOADING A PATCHED TEST COPY of the extension (${dest})`,
    )
    console.log(
        `[test]    bundled dev stamp rewritten -> ${API_BASE} (copy only; shipped output untouched)`,
    )
    console.log(
        `[test]    host permission ${API_BASE}/* granted to the copy only`,
    )
    return dest
}

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
    console.log(`[test] extension source: ${EXT_PATH}`)
    console.log(`[test] api base: ${API_BASE}`)

    // The browser loads the PATCHED TEMP COPY, never the shipped source dir
    // (see the module header — base URL rewritten to the local app).
    const patchedExtPath = stagePatchedExtensionCopy()

    const userDataDir = path.join(
        process.env.TEMP || '/tmp',
        `caramel-ext-test-${Date.now()}`,
    )
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        channel: 'chromium',
        args: [
            `--disable-extensions-except=${patchedExtPath}`,
            `--load-extension=${patchedExtPath}`,
            '--no-first-run',
        ],
    })

    try {
        // 1. Service worker boots
        const sw = await waitForServiceWorker(context)
        log('service worker booted', !!sw, sw ? sw.url() : 'timeout')
        if (!sw) throw new Error('Background service worker never started')

        const extensionId = new URL(sw.url()).host

        // 2. Patched base URL in effect. This asserts what THIS SUITE staged
        // (the temp copy's rewritten environment stamp), not shipped behavior —
        // a real build's stamp names the dev or the production deployment. It
        // proves the browser really loaded the patched copy, so every later
        // step talks to the hermetic local app instead of a remote deployment.
        await new Promise(r => setTimeout(r, 1500))
        const baseUrl = await sw.evaluate(() => globalThis.CARAMEL_BASE_URL)
        log(
            'patched dev base URL in effect',
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
        const storesRes = await sw.evaluate(async url => {
            const r = await fetch(url)
            return {
                status: r.status,
                body: await r.json().catch(() => null),
            }
        }, `${API_BASE}/api/extension/supported-stores`)
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
            async url => {
                const r = await fetch(url)
                return {
                    status: r.status,
                    body: await r.json().catch(() => null),
                }
            },
            `${API_BASE}/api/coupons?site=${encodeURIComponent(sample?.domain || 'allbirds.com')}`,
        )
        log(
            'coupons endpoint',
            couponsRes.status === 200,
            `status=${couponsRes.status}`,
        )

        // 7. POPUP UI LOGIN FLOW
        {
            // Clear BOTH storage areas so the popup starts logged out —
            // sessions live in storage.local since the sync->local migration.
            await sw.evaluate(
                () =>
                    new Promise(res =>
                        chrome.storage.local.remove(['token', 'user'], () =>
                            chrome.storage.sync.remove(['token', 'user'], res),
                        ),
                    ),
            )

            const popup = await context.newPage()
            // popup.html since the WXT P1 port (was index.html)
            await popup.goto(`chrome-extension://${extensionId}/popup.html`)
            await popup.waitForLoadState('domcontentloaded')
            await popup.waitForTimeout(800)

            const hasLoginToggle =
                (await popup.locator('#loginToggleBtn').count()) > 0
            if (hasLoginToggle) await popup.locator('#loginToggleBtn').click()

            try {
                await popup.waitForSelector('#email', { timeout: 5000 })
            } catch (err) {
                // Diagnostic dump: what did the popup actually render?
                const diag = await popup
                    .evaluate(() => ({
                        url: location.href,
                        loaderShown: (() => {
                            const l =
                                document.getElementById('loading-container')
                            return l ? getComputedStyle(l).display : 'absent'
                        })(),
                        visibleIds: [...document.querySelectorAll('[id]')]
                            .filter(el => el.offsetParent !== null)
                            .map(el => el.id)
                            .slice(0, 40),
                        authContainer: (
                            document.getElementById('auth-container')
                                ?.innerHTML || '(empty)'
                        ).slice(0, 1500),
                        bodyText: (document.body.innerText || '').slice(0, 600),
                    }))
                    .catch(e => ({ evalFailed: String(e) }))
                console.log(
                    '[diag] popup state at #email timeout:',
                    JSON.stringify(diag, null, 2),
                )
                throw err
            }
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

            // Give storage a moment to flush. Sessions live in storage.LOCAL
            // since the sync->local migration (credentials must not roam via
            // Chrome Sync); sync is read as the pre-migration fallback only.
            await popup.waitForTimeout(500)
            const stored = await sw.evaluate(
                () =>
                    new Promise(res =>
                        chrome.storage.local.get(['token', 'user'], local => {
                            if (local?.token) return res(local)
                            chrome.storage.sync.get(['token', 'user'], res)
                        }),
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
            // The old harness eval'd the classic-script files one by one; the
            // sources are ES modules now, so esbuild bundles the REAL module
            // graph (from the shipped sources on disk) into one classic
            // script, with the same __CARAMEL_ENV__ define mechanism the real
            // build uses — pointed at the local app. The driver entry calls
            // the same inits the content entrypoint calls (minus inject: this
            // step drives applyCoupon directly, not checkout detection) and
            // publishes the one handle the page code below needs.
            const stamp = {
                ...stampFor('development'),
                baseUrl: API_BASE,
            }
            const driver = await esbuild({
                stdin: {
                    contents: `
                        import { initCaramelBase } from './caramel-base.js'
                        import { initCouponConstants } from './coupon-constants.generated.js'
                        import { initCouponRunner } from './coupon-runner.js'
                        import { applyCoupon } from './coupon-apply.js'
                        initCouponConstants()
                        initCaramelBase()
                        initCouponRunner()
                        globalThis.applyCoupon = applyCoupon
                    `,
                    resolveDir: EXT_PATH,
                },
                bundle: true,
                format: 'iife',
                write: false,
                define: { __CARAMEL_ENV__: JSON.stringify(stamp) },
            })
            const driverSource = driver.outputFiles[0].text

            const page = await context.newPage()
            // about:blank has no CSP so we can freely inject via page.evaluate
            await page.goto('about:blank')
            await page.setContent(`<!doctype html><html><body>
                <div class="price" id="total">$100.00</div>
                <input id="coupon-field" type="text" />
                <button id="apply-btn">Apply</button>
            </body></html>`)

            // Wire the click handler and the chrome stub FIRST — the driver's
            // inits read chrome/window exactly like the real realm start —
            // then evaluate the bundled graph.
            await page.evaluate(driverSource => {
                window.__clickLog = []
                document
                    .getElementById('apply-btn')
                    .addEventListener('click', () => {
                        window.__clickLog.push({
                            code: document.getElementById('coupon-field').value,
                        })
                        document.getElementById('total').textContent = '$90.00'
                    })
                // Stub chrome APIs the realm touches during init.
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
                ;(0, eval)(driverSource)
            }, driverSource)

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
        // Best-effort: the patched copy is a throwaway in the OS temp dir.
        rmSync(patchedExtPath, { recursive: true, force: true })
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
