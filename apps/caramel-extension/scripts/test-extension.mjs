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
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
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

/* ── 7b. the Google Chrome daily-active ping ────────────────────────────────
 *
 * Two modes, chosen by how the APP under test was booted:
 *
 *   CARAMEL_E2E_POSTHOG_MOCK_PORT set — the app runs with
 *     EXTENSION_DAU_TELEMETRY_ENABLED=true, POSTHOG_DATASET=e2e and its e2e
 *     PostHog host pointed at http://localhost:<port>, where THIS script
 *     listens. That is a MOCK of PostHog's ingestion endpoint: the real
 *     posthog-node SDK in the real route sends to it, nothing reaches any real
 *     PostHog project, and what is verified is the capture REQUEST, not
 *     ingestion.
 *   unset — the app's own .env decides; the default (switch off) must answer
 *     `disabled`, which proves the full popup → worker → route path and that a
 *     disabled answer is not recorded as a counted day.
 *
 * Playwright's Chromium reports no "Google Chrome" UA-CH brand, so the popup
 * opened in step 7 must have sent nothing (the browser-scope gate, checked
 * first). The positive path then EMULATES Google Chrome's brand list on the
 * popup page over CDP — a test seam for the brand check only; the Safari and
 * Edge exclusions are pinned by the unit suites. */
const MOCK_PORT = Number(process.env.CARAMEL_E2E_POSTHOG_MOCK_PORT) || 0
const GOOGLE_CHROME_UA_METADATA = {
    brands: [
        { brand: 'Chromium', version: '130' },
        { brand: 'Google Chrome', version: '130' },
        { brand: 'Not?A_Brand', version: '99' },
    ],
    fullVersion: '130.0.0.0',
    platform: 'Linux',
    platformVersion: '',
    architecture: 'x86',
    model: '',
    mobile: false,
}

/** Mock PostHog ingestion: records every POST body (gunzipped, JSON-parsed)
 * and answers 200 after `holdMs`, so the test can close the popup while the
 * route — and therefore the worker's request — is still waiting. */
function startPosthogMock(port, holdMs) {
    const received = []
    const server = createServer((req, res) => {
        const chunks = []
        req.on('data', c => chunks.push(c))
        req.on('end', () => {
            let raw = Buffer.concat(chunks)
            if (/gzip/.test(req.headers['content-encoding'] || ''))
                raw = gunzipSync(raw)
            let body = null
            try {
                body = JSON.parse(raw.toString('utf8'))
            } catch {
                body = raw.toString('utf8')
            }
            received.push({ path: req.url, body })
            setTimeout(() => {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end('{"status":"Ok"}')
            }, holdMs)
        })
    })
    return new Promise(resolve =>
        server.listen(port, '127.0.0.1', () => resolve({ server, received })),
    )
}

/** Every captured event object named `name`, wherever the SDK's envelope
 * (batch v0 or capture v1) put it. */
function findEvents(node, name, out = []) {
    if (Array.isArray(node)) node.forEach(n => findEvents(n, name, out))
    else if (node && typeof node === 'object') {
        if (node.event === name) out.push(node)
        else Object.values(node).forEach(v => findEvents(v, name, out))
    }
    return out
}

const readActivityStorage = sw =>
    sw.evaluate(
        () =>
            new Promise(res =>
                chrome.storage.local.get(
                    [
                        'caramel_activity_seed',
                        'caramel_activity_state',
                        'token',
                    ],
                    res,
                ),
            ),
    )

async function waitForActivityState(sw, predicate, timeout = 20000) {
    const start = Date.now()
    while (Date.now() - start < timeout) {
        const s = await readActivityStorage(sw)
        if (predicate(s.caramel_activity_state)) return s
        await new Promise(r => setTimeout(r, 250))
    }
    return readActivityStorage(sw)
}

async function openPopupAsGoogleChrome(context, extensionId) {
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    const ua = await page.evaluate(() => navigator.userAgent)
    await cdp.send('Emulation.setUserAgentOverride', {
        userAgent: ua,
        userAgentMetadata: GOOGLE_CHROME_UA_METADATA,
    })
    await page.goto(`chrome-extension://${extensionId}/popup.html`)
    return page
}

async function checkDailyActivePing(context, sw, extensionId) {
    // (a) Plain Chromium (step 7's popup) is not Google Chrome: no seed, no state.
    const before = await readActivityStorage(sw)
    log(
        'DAU: plain Chromium popup open sends nothing',
        !before.caramel_activity_seed && !before.caramel_activity_state,
        `seed=${before.caramel_activity_seed ? 'present' : 'absent'}`,
    )

    // `next dev` compiles a route on its first request (measured 2026-10-05:
    // ~5 s cold), which can outrun the worker's 8 s fetch budget and turn a
    // successful capture into a "lost response" retry. A preflight compiles
    // the same route module and captures nothing.
    await fetch(`${API_BASE}/api/extension/activity`, { method: 'OPTIONS' })
    const mock = MOCK_PORT ? await startPosthogMock(MOCK_PORT, 1000) : null
    try {
        // (b) Popup open as Google Chrome, closed mid-delivery.
        const popup = await openPopupAsGoogleChrome(context, extensionId)
        const brandSeen = await popup.evaluate(() =>
            (navigator.userAgentData?.brands || []).map(b => b.brand),
        )
        if (mock) {
            // The capture reached the mock ⇒ the worker's request is inside the
            // route, which is now waiting on the held mock response. Close the
            // popup here: delivery must not depend on it.
            const start = Date.now()
            while (!mock.received.length && Date.now() - start < 15000)
                await new Promise(r => setTimeout(r, 100))
        } else {
            await popup.waitForTimeout(300)
        }
        await popup.close()

        if (mock) {
            const after = await waitForActivityState(sw, s => s?.recordedDay)
            const today = new Date().toISOString().slice(0, 10)
            const events = findEvents(
                mock.received.map(r => r.body),
                'extension_active',
            )
            const ev = events[0]
            const props = ev?.properties || {}
            const wire = JSON.stringify(mock.received)
            const okEvent =
                events.length === 1 &&
                /^[0-9a-f]{64}$/.test(ev.distinct_id) &&
                props.day === today &&
                props.browser === 'chrome' &&
                typeof props.extension_version === 'string' &&
                props.signed_in === !!after.token &&
                props.platform === 'extension' &&
                props.$process_person_profile === false &&
                !wire.includes(after.caramel_activity_seed) &&
                !(after.token && wire.includes(after.token)) &&
                !wire.includes(TEST_EMAIL)
            log(
                'DAU: popup → worker → route → PostHog capture request (MOCK host, not live ingestion)',
                okEvent,
                `brands=${brandSeen.join('|')} events=${events.length} signed_in=${props.signed_in} keys=${Object.keys(
                    props,
                )
                    .filter(k => !k.startsWith('$lib'))
                    .join(',')}`,
            )
            log(
                'DAU: day recorded by the worker after the popup closed',
                after.caramel_activity_state?.recordedDay === today,
                JSON.stringify(after.caramel_activity_state),
            )

            // (c) Same-day repeat open: no second request.
            const again = await openPopupAsGoogleChrome(context, extensionId)
            await again.waitForTimeout(2500)
            await again.close()
            const repeat = findEvents(
                mock.received.map(r => r.body),
                'extension_active',
            )
            log(
                'DAU: repeat popup open the same UTC day sends nothing',
                repeat.length === 1,
                `events=${repeat.length}`,
            )
        } else {
            const after = await waitForActivityState(
                sw,
                s => s?.retryAfter || s?.recordedDay,
            )
            const st = after.caramel_activity_state
            log(
                'DAU: popup → worker → route answered disabled (switch off); day NOT recorded, cooldown set',
                !!after.caramel_activity_seed &&
                    !st?.recordedDay &&
                    !!st?.retryAfter,
                `brands=${brandSeen.join('|')} state=${JSON.stringify(st)}`,
            )
        }
    } finally {
        mock?.server.close()
    }
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

            // Bounded wait, not a one-shot count: the React popup (WXT P2)
            // paints this button only after resolvePopupState's fetch lands,
            // which on a cold CI runner can outrun the 800ms settle above.
            const loginToggle = popup.locator('#loginToggleBtn')
            try {
                await loginToggle.waitFor({ state: 'visible', timeout: 10000 })
            } catch {
                // Absent is a legal state (already signed in); the #email
                // wait below is the real assertion either way.
            }
            if ((await loginToggle.count()) > 0) await loginToggle.click()

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

        // 7b. DAILY-ACTIVE PING — popup open → worker → POST
        // /api/extension/activity → the route's PostHog capture boundary.
        await checkDailyActivePing(context, sw, extensionId)

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
