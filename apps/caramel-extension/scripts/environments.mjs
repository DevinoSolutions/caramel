/**
 * The deployment-environment table — the ONE source of truth for what a build
 * talks to. Extracted from build-dist.mjs in the WXT P1 port (2026-08-12) so
 * every consumer reads the same object:
 *
 *   - wxt.config.ts inlines the selected entry into the bundles as the
 *     `__CARAMEL_ENV__` define (caramel-env.js re-exports it as CARAMEL_ENV),
 *   - vitest.config.mjs inlines the PRODUCTION entry for the unit suite,
 *   - scripts/parity-harness.mjs asserts the built artifacts carry exactly
 *     these values and nothing from the other environment.
 *
 * Which environment a build gets is decided AT BUILD TIME (wxt mode:
 * production by default, dev takes an explicit `--mode development`, anything
 * else throws). It used to be decided at runtime from
 * `chrome.runtime.getManifest().update_url` — a Chrome-Web-Store-only field —
 * which shipped Firefox and Safari builds pointed at the dev deployment. The
 * full incident write-up lives in tests/build-environment.test.mjs and the
 * git history of build-dist.mjs.
 */
export const ENVIRONMENTS = {
    production: {
        baseUrl: 'https://grabcaramel.com',
        // Origins trusted to postMessage a login token into extension
        // storage. They must match the deployment this build talks to: a
        // build whose API is dev has no business accepting a PRODUCTION
        // session relayed from a prod tab, and vice versa.
        trustedOrigins: [
            'https://grabcaramel.com',
            'https://www.grabcaramel.com',
        ],
        // Content scripts run on https://*/*, so a console call lands in a
        // STORE's console on a shopper's machine. Never in a shipped build.
        verbose: false,
    },
    development: {
        baseUrl: 'https://dev.grabcaramel.com',
        trustedOrigins: [
            'https://dev.grabcaramel.com',
            'http://localhost:58000',
        ],
        verbose: true,
    },
}

/** The stamp object a build inlines as `__CARAMEL_ENV__`. */
export function stampFor(name) {
    const env = ENVIRONMENTS[name]
    if (!env) {
        throw new Error(
            `unknown environment "${name}" — expected one of ${Object.keys(ENVIRONMENTS).join(', ')}`,
        )
    }
    return {
        name,
        isProduction: name === 'production',
        baseUrl: env.baseUrl,
        trustedOrigins: env.trustedOrigins,
        verbose: env.verbose,
    }
}
