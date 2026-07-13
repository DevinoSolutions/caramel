import tsconfigPaths from 'vite-tsconfig-paths'
import { configDefaults, defineConfig } from 'vitest/config'

// Unit baseline (F-004). Playwright owns `e2e/**` (playwright.config.ts
// testDir: './e2e') — excluded here so vitest never tries to collect it.
// `**/*.eval.*` is reserved for F-012's separate eval harness.
export default defineConfig({
    plugins: [tsconfigPaths()],
    test: {
        environment: 'node',
        // F-011 — .tsx added alongside .ts: error.test.tsx/global-error.test.tsx
        // are the first tests to render JSX (RTL). Per-file environment stays
        // node by default; jsdom-needing files opt in via a
        // `// @vitest-environment jsdom` pragma (see tests/unit/error.test.tsx).
        include: ['tests/unit/**/*.test.{ts,tsx}'],
        exclude: [...configDefaults.exclude, 'e2e/**', '**/*.eval.*'],
        setupFiles: ['./tests/setup.ts'],
        // F-005: src/lib/env.ts eager-parses process.env at import time.
        // These are the 3 vars its schema requires — without them, any test
        // that transitively imports env.ts (most do, via rateLimit/auth/etc)
        // would throw before a single assertion runs. Values are dummies;
        // no test relies on them being reachable/real.
        env: {
            DATABASE_URL:
                'postgresql://postgres:postgres@localhost:58005/caramel?schema=public',
            COUPONS_DATABASE_URL:
                'postgresql://postgres:postgres@localhost:58005/caramel_coupons',
            BETTER_AUTH_SECRET: 'vitest-fixture-better-auth-secret',
        },
    },
})
