import { defineConfig, devices } from '@playwright/test'
import * as dotenv from 'dotenv'
import * as path from 'path'

// Load environment variables for E2E tests
dotenv.config({ path: path.resolve(__dirname, '../../local-dev/.env.ports') })

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
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: 'html',
    use: {
        baseURL,
        trace: 'on-first-retry',
    },
    ...(startServer
        ? {
              webServer: {
                  command: process.env.PLAYWRIGHT_WEB_COMMAND || 'pnpm dev',
                  url: baseURL,
                  timeout: webServerTimeout,
                  reuseExistingServer: !process.env.CI,
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
