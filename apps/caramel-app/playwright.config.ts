import { createArgosReporterOptions } from '@argos-ci/playwright/reporter'
import { defineConfig, devices } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

// Load this package's .env (the same file setup:ci-env writes in CI, and the
// one `prisma migrate deploy` reads) so DATABASE_URL reaches the DB-seeding
// e2e specs (E-05 real-login). Guarded by existsSync exactly like
// vitest.integration.config.ts: the e2e-push job runs against a DEPLOYED site
// with NO local .env, so the file is simply absent there — DATABASE_URL stays
// unset and the seed-dependent specs skip themselves (see e2e/support/seed-user.ts).
// (Playwright transpiles this config to CJS, so __dirname is available and
// import.meta.url is not — unlike the Vite-run vitest configs.)
const envPath = path.resolve(__dirname, '.env')
if (fs.existsSync(envPath)) {
    process.loadEnvFile(envPath)
}

const baseURL =
    process.env.PLAYWRIGHT_BASE_URL ||
    process.env.BASE_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    'http://localhost:58000'
const startServer = process.env.PLAYWRIGHT_START_SERVER !== 'false'
const webServerTimeout = Number(process.env.PLAYWRIGHT_WEB_TIMEOUT ?? '180000')

export default defineConfig({
    testDir: './e2e',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    failOnFlakyTests: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: [
        ['github'],
        process.env.CI ? ['dot'] : ['list'],
        [
            '@argos-ci/playwright/reporter',
            createArgosReporterOptions({
                // Upload permanently OFF (2026-08-13, issue #194): the Argos
                // account is retired and the end-of-run upload threw APIError
                // AFTER a green 108-test suite, keeping the whole workflow
                // red on every main push. Snapvisor owns visual diffs now;
                // the argosScreenshot specs stay as deterministic render
                // smoke + local screenshot artifacts.
                uploadToArgos: false,
                buildName: 'caramel-app',
            }),
        ],
    ],
    use: {
        baseURL,
        trace: 'on-first-retry',
        screenshot: 'only-on-failure',
        // The app has first-class prefers-reduced-motion support: the 3D
        // hero/vault scenes render their static CSS posters instead of
        // mounting WebGL, and the store marquee stops translating. Running
        // e2e with it ON keeps CI deterministic — otherwise SwiftShader
        // software-renders the R3F canvases on a 2-core runner and the CPU
        // starvation flakes unrelated tests (nav toHaveURL timeouts), and
        // the marquee translates lazy images offscreen where they never
        // load and stall Argos. The WebGL path is verified locally/manually.
        contextOptions: {
            reducedMotion: 'reduce',
        },
    },
    ...(startServer
        ? {
              webServer: {
                  command: process.env.PLAYWRIGHT_WEB_COMMAND || 'pnpm dev',
                  url: baseURL,
                  timeout: webServerTimeout,
                  reuseExistingServer: !process.env.CI,
                  // Playwright launches the app server with { ...process.env,
                  // ...webServer.env }, so this MERGES over the inherited env.
                  // In the PostHog real-ingestion e2e mode the Playwright
                  // process carries POSTHOG_E2E_TEST_PROJECT_QUERY_READ_ONLY_
                  // PERSONAL_API_KEY (the Query API read key — used ONLY by
                  // e2e/support/posthog.ts). env.ts fail-fasts at boot if that
                  // key is present in an app/server env, so we blank it for the
                  // app process ONLY: '' is falsy, so env.ts's presence guard
                  // passes, while the Playwright test process keeps the real
                  // value in its own process.env for the Query API calls. The
                  // dataset switches (POSTHOG_DATASET / NEXT_PUBLIC_POSTHOG_*)
                  // are inherited from the parent env unchanged.
                  env: {
                      POSTHOG_E2E_TEST_PROJECT_QUERY_READ_ONLY_PERSONAL_API_KEY:
                          '',
                  },
              },
          }
        : {}),
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
})
