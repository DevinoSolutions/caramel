import { defineConfig } from 'vitest/config'
import { stampFor } from './scripts/environments.mjs'

// Unit baseline (F-004), ESM era (WXT P1, 2026-08-12): extension source files
// are ES modules — suites import them directly. The `__CARAMEL_ENV__` define
// mirrors wxt.config.ts so caramel-env.js resolves under vitest exactly as it
// does in a build; PRODUCTION values, matching the old harness default
// (tests/_load.mjs installEnvStamp), so a suite asserting production behavior
// cannot accidentally pick up the dev stamp. Legacy suites not yet ported
// still eval pre-ESM copies through tests/_load.mjs during the port window.
export default defineConfig({
    define: {
        __CARAMEL_ENV__: JSON.stringify(stampFor('production')),
    },
    test: {
        environment: 'jsdom',
        include: ['tests/**/*.test.mjs'],
    },
})
