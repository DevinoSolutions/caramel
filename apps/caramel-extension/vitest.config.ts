import { defineConfig } from 'vitest/config'
import { stampFor } from './scripts/environments.mjs'

// Unit baseline (F-004), ESM era (WXT P1, 2026-08-12): extension source files
// are ES modules — suites import them directly. The `__CARAMEL_ENV__` define
// mirrors wxt.config.ts so caramel-env.js resolves under vitest exactly as it
// does in a build; PRODUCTION values, matching the retired eval-harness
// default (tests/_load.mjs installEnvStamp — deleted with the old build), so
// a suite asserting production behavior cannot accidentally pick up the dev
// stamp.
//
// React era (WXT P2, 2026-08-13): popup view suites are .test.tsx rendered
// with @testing-library/react — `jsx: 'automatic'` mirrors the build's
// react-jsx transform, and the setup file registers the jest-dom matchers.
export default defineConfig({
    esbuild: { jsx: 'automatic' },
    define: {
        __CARAMEL_ENV__: JSON.stringify(stampFor('production')),
    },
    test: {
        environment: 'jsdom',
        include: ['tests/**/*.test.{mjs,tsx}'],
        setupFiles: ['tests/_vitest-setup.ts'],
    },
})
