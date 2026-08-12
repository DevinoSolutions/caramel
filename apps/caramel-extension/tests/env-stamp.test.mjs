/**
 * The environment stamp, post-WXT: what a build talks to is decided by HOW IT
 * WAS BUILT — the __CARAMEL_ENV__ define (wxt.config.ts / vitest.config.mjs,
 * both fed by scripts/environments.mjs) inlined into caramel-env.js.
 *
 * Slim successor to the retired tests/build-environment.test.mjs, which
 * asserted on the OLD build's dist/ output (deleted with scripts/
 * build-dist.mjs). The built-output halves of those pins now live in
 * scripts/parity-harness.mjs: the per-browser dev-target greps, the
 * update_url/_isDevInstall scan, and the missing-reference checks all run
 * against .output/* there. What belongs HERE is the module contract every
 * realm inherits from the import graph.
 */

import { describe, expect, it } from 'vitest'
import { CARAMEL_BASE_URL, CARAMEL_ENV } from '../caramel-env.js'
import { ENVIRONMENTS, stampFor } from '../scripts/environments.mjs'

const PROD_URL = 'https://grabcaramel.com'

describe('the ESM stamp module (define-fed, frozen)', () => {
    it('carries the production stamp under vitest — same default the build has', () => {
        expect(CARAMEL_ENV.name).toBe('production')
        expect(CARAMEL_ENV.isProduction).toBe(true)
        expect(CARAMEL_ENV.baseUrl).toBe(PROD_URL)
        expect(CARAMEL_BASE_URL).toBe(PROD_URL)
    })

    it('is deeply frozen — no runtime mutation can repoint a build', () => {
        expect(Object.isFrozen(CARAMEL_ENV)).toBe(true)
        expect(Object.isFrozen(CARAMEL_ENV.trustedOrigins)).toBe(true)
    })

    it('publishes the window/worker globals the harnesses and probes read', () => {
        // scripts/test-extension.mjs reads CARAMEL_BASE_URL out of the live
        // worker; scripts/smoke-package.mjs reads CARAMEL_ENV off the popup.
        expect(globalThis.CARAMEL_ENV).toBe(CARAMEL_ENV)
        expect(globalThis.CARAMEL_BASE_URL).toBe(CARAMEL_BASE_URL)
    })
})

describe('the environment table', () => {
    it('every environment names a distinct deployment', () => {
        const urls = Object.values(ENVIRONMENTS).map(e => e.baseUrl)
        expect(new Set(urls).size).toBe(urls.length)
    })

    it('production trusts no dev origin to postMessage a session token in', () => {
        const prod = stampFor('production')
        expect(prod.trustedOrigins).toContain(PROD_URL)
        for (const origin of prod.trustedOrigins) {
            expect(
                ['dev.grabcaramel.com', 'localhost', '127.0.0.1'].some(t =>
                    origin.includes(t),
                ),
            ).toBe(false)
        }
    })

    it('a dev build trusts dev origins and NOT production ones', () => {
        const dev = stampFor('development')
        expect(dev.trustedOrigins).toContain('https://dev.grabcaramel.com')
        expect(dev.trustedOrigins).toContain('http://localhost:58000')
        expect(dev.trustedOrigins).not.toContain(PROD_URL)
    })

    it('rejects an environment name that does not exist', () => {
        expect(() => stampFor('staging')).toThrow(
            /unknown environment "staging"/,
        )
    })
})
