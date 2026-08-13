#!/usr/bin/env node
/**
 * Loads a BUILT package in a real Chrome and asserts which deployment it
 * resolved to — in the service worker, where the fetch chokepoint lives, and
 * on the popup page, where the postMessage origin allowlist is built.
 *
 * This is the regression test for the bug the environment stamp exists to fix.
 * The extension used to decide dev-vs-production at runtime from
 * `chrome.runtime.getManifest().update_url`, a field only the Chrome Web Store
 * injects — so an unpacked directory (and therefore every Firefox/AMO upload
 * and the converted Safari build) answered "dev" and pointed real users' API
 * calls, login tab and store catalog at the dev deployment, while trusting a
 * local server to hand it a session token. Loading the built package UNPACKED
 * reproduces exactly that condition, which is what makes this cheap check the
 * one that would have caught it.
 *
 * Deliberately separate from test-guards.mjs: that suite asserts on the
 * extension's own diagnostic log markers and therefore needs a
 * development-stamped package, so it can never be the thing that watches the
 * PRODUCTION package. This can, in about ten seconds.
 *
 * Run: node scripts/smoke-package.mjs <package-dir> <environment>
 *      node scripts/smoke-package.mjs ./.output/chrome-mv3 production
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { ENVIRONMENTS } from './environments.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Default is the WXT production build. It used to be `dist` — the hand-rolled
// build's output, deleted in P1 (2026-08-12) — so a bare invocation pointed at
// a directory that no longer exists and reported that as a package problem.
const PACKAGE_DIR = path.resolve(
    __dirname,
    '..',
    process.argv[2] || '.output/chrome-mv3',
)
const ENVIRONMENT = process.argv[3] || 'production'

const expected = ENVIRONMENTS[ENVIRONMENT]
if (!expected) {
    console.error(
        `[smoke] unknown environment "${ENVIRONMENT}" — expected one of ${Object.keys(ENVIRONMENTS).join(', ')}`,
    )
    process.exit(1)
}

const failures = []
const check = (name, ok, detail) => {
    console.log(
        `  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`,
    )
    if (!ok) failures.push(name)
}

const profile = mkdtempSync(path.join(tmpdir(), 'caramel-smoke-'))
let context

try {
    context = await chromium.launchPersistentContext(profile, {
        headless: false, // MV3 service workers do not start in headless mode
        args: [
            `--disable-extensions-except=${PACKAGE_DIR}`,
            `--load-extension=${PACKAGE_DIR}`,
            '--no-first-run',
        ],
    })

    // Block the network without touching chrome-extension:// URLs — a
    // catch-all route stalls the extension's own script loads and the popup
    // comes up with nothing defined.
    await context.route(/^https?:\/\//, route => route.abort())

    console.log(`\n=== ${PACKAGE_DIR} — expecting ${ENVIRONMENT} ===`)

    const worker =
        context.serviceWorkers()[0] ||
        (await context.waitForEvent('serviceworker', { timeout: 30000 }))

    const fromWorker = await worker.evaluate(() => ({
        baseUrl: globalThis.CARAMEL_BASE_URL,
        name: globalThis.CARAMEL_ENV?.name,
        apiUrl: new URL(
            'api/coupons',
            `${globalThis.CARAMEL_BASE_URL}/`,
        ).toString(),
    }))

    check(
        'the service worker resolves the expected deployment',
        fromWorker.baseUrl === expected.baseUrl,
        fromWorker.baseUrl,
    )
    check(
        'every API URL it builds points there',
        fromWorker.apiUrl.startsWith(`${expected.baseUrl}/`),
        fromWorker.apiUrl,
    )
    check(
        'the worker carries the expected stamp',
        fromWorker.name === ENVIRONMENT,
        fromWorker.name,
    )

    const popup = await context.newPage()
    const pageErrors = []
    popup.on('pageerror', err => pageErrors.push(String(err?.message || err)))
    // popup.html since the WXT P1 port (was index.html). The old probe also
    // read the bare CARAMEL_ALLOWED_ORIGINS global; that Set lives in module
    // scope now and is invisible to page scripts, so the origin check reads
    // the published stamp instead — same source of truth (caramel-base builds
    // the Set from CARAMEL_ENV.trustedOrigins; the construction itself is
    // unit-pinned in tests/).
    await popup.goto(
        `chrome-extension://${new URL(worker.url()).host}/popup.html`,
    )
    const fromPopup = await popup.evaluate(() => ({
        name: globalThis.CARAMEL_ENV?.name,
        baseUrl: globalThis.CARAMEL_ENV?.baseUrl,
        trusted: globalThis.CARAMEL_ENV?.trustedOrigins
            ? [...globalThis.CARAMEL_ENV.trustedOrigins]
            : null,
    }))

    check(
        'the popup page carries the same stamp',
        fromPopup.name === ENVIRONMENT &&
            fromPopup.baseUrl === expected.baseUrl,
        `${fromPopup.name} ${fromPopup.baseUrl}`,
    )
    check(
        'it trusts exactly the origins this environment declares',
        JSON.stringify([...(fromPopup.trusted || [])].sort()) ===
            JSON.stringify([...expected.trustedOrigins].sort()),
        JSON.stringify(fromPopup.trusted),
    )
    check(
        'the popup loaded without a page error',
        pageErrors.length === 0,
        pageErrors.join(' | '),
    )
} finally {
    if (context) await context.close()
    rmSync(profile, { recursive: true, force: true })
}

if (failures.length) {
    console.error(`\nFAILED: ${failures.join('; ')}\n`)
    process.exit(1)
}
console.log('\nall checks passed.\n')
