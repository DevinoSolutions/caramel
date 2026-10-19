import type { ErrorEvent } from '@sentry/nextjs'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { INJECTED_SCRIPT_DENY_URLS } from '@/lib/sentryInjectedScriptNoise'

// Under Node, `@sentry/nextjs` resolves to its CommonJS server build, whose
// re-exports an ESM import cannot see, so it is loaded through `require`. It is
// the same @sentry/core integration the browser build re-exports.
const { eventFiltersIntegration } = createRequire(import.meta.url)(
    '@sentry/nextjs',
) as typeof import('@sentry/nextjs')

// T-2935: CARAMEL-Z / VOICELABS-WEB-15 are an extension-injected script
// (`executors/200.js`) throwing `Cannot read properties of undefined (reading
// 'M_ID')` into our window.onunhandledrejection. The browser init passes
// INJECTED_SCRIPT_DENY_URLS as `denyUrls`; these tests run the SDK's own
// EventFilters step (the integration that applies `denyUrls`) on events shaped
// like the real ones, so they prove what the SDK drops, not what a regex says.

const M_ID_MESSAGE = "Cannot read properties of undefined (reading 'M_ID')"

function rejectionFrom(filename: string, value = M_ID_MESSAGE): ErrorEvent {
    return {
        type: undefined,
        exception: {
            values: [
                {
                    type: 'TypeError',
                    value,
                    mechanism: {
                        type: 'auto.browser.global_handlers.onunhandledrejection',
                        handled: false,
                    },
                    // Sentry orders frames oldest first; the last frame threw.
                    stacktrace: {
                        frames: [
                            { filename, function: 'Y', lineno: 1, colno: 761 },
                            { filename, function: 'E', lineno: 1, colno: 1442 },
                        ],
                    },
                },
            ],
        },
    }
}

function survivesTheBrowserFilters(event: ErrorEvent): boolean {
    const filters = eventFiltersIntegration({
        denyUrls: INJECTED_SCRIPT_DENY_URLS,
    })
    type FilterClient = Parameters<NonNullable<typeof filters.processEvent>>[2]
    // A client stub with no options of its own: only the denyUrls above apply.
    const client = { getOptions: () => ({}) } as unknown as FilterClient
    return filters.processEvent?.(event, {}, client) !== null
}

describe('the injected executors/<n>.js script never reaches Sentry', () => {
    it.each([
        'app:///executors/200.js',
        'executors/200.js',
        'https://grabcaramel.com/executors/200.js',
        'chrome-extension://abcdefghijklmnopabcdefghijklmnop/executors/200.js',
        'https://grabcaramel.com/executors/31.js?v=2',
    ])('drops the M_ID rejection thrown from %s', filename => {
        expect(survivesTheBrowserFilters(rejectionFrom(filename))).toBe(false)
    })
})

describe('our own errors still report', () => {
    it.each([
        'app:///_next/static/chunks/app/welcome/page-3f2a.js',
        'https://grabcaramel.com/_next/static/chunks/executors.js',
        'https://grabcaramel.com/_next/static/chunks/executors/abc.js',
        'app:///_next/static/chunks/myexecutors/200.js',
    ])(
        'keeps an error thrown from %s, even with the same message',
        filename => {
            expect(survivesTheBrowserFilters(rejectionFrom(filename))).toBe(
                true,
            )
        },
    )
})

describe('the browser init passes the list as denyUrls', () => {
    it('src/instrumentation-client.ts wires INJECTED_SCRIPT_DENY_URLS', () => {
        const source = readFileSync(
            join(__dirname, '..', '..', 'src', 'instrumentation-client.ts'),
            'utf8',
        )
        const init = source.slice(source.indexOf('Sentry.init('))
        expect(init).toMatch(/denyUrls:\s*INJECTED_SCRIPT_DENY_URLS/)
        expect(source).toMatch(
            /import \{ INJECTED_SCRIPT_DENY_URLS \} from '@\/lib\/sentryInjectedScriptNoise'/,
        )
    })
})
