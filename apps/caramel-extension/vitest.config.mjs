import { defineConfig } from 'vitest/config'

// Unit baseline (F-004). Extension source is plain <script>-global JS (no
// bundler, no import/export) — tests/_load.mjs reads+evals it into jsdom,
// the same trick scripts/test-extension.mjs already uses against a real
// browser page for the Playwright e2e suite.
export default defineConfig({
    test: {
        environment: 'jsdom',
        include: ['tests/**/*.test.mjs'],
    },
})
