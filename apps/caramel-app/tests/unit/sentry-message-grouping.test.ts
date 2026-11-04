import * as Sentry from '@sentry/nextjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// SDK v11 defaults attachStacktrace to true (v10 left it off). With it on, a
// captureMessage carries a synthetic stack and Sentry groups and titles the
// warning by its minified in-app frame, so every deploy (new chunk hashes)
// opened a fresh issue named "x" or "Z": CARAMEL-31/32 split off CARAMEL-1A
// after the 10-25 deploy (T-9161). Every init must turn it back off.
const app = join(__dirname, '..', '..')

afterEach(() => {
    vi.doUnmock('@sentry/nextjs')
    vi.unstubAllEnvs()
    vi.resetModules()
})

describe('Sentry message events group by their text, not a minified frame', () => {
    it('the server/edge init passes attachStacktrace: false to Sentry.init', async () => {
        vi.resetModules()
        vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://key@sentry.example/1')
        vi.stubEnv('NODE_ENV', 'production')
        const init = vi.fn()
        vi.doMock('@sentry/nextjs', () => ({ init }))
        const { initSentry } = await import('../../sentry.common.config')
        initSentry()
        expect(init).toHaveBeenCalledTimes(1)
        expect(init.mock.calls[0]?.[0]).toMatchObject({
            attachStacktrace: false,
        })
    }, 30_000)

    it('the browser init sets attachStacktrace: false', () => {
        const source = readFileSync(
            join(app, 'src/instrumentation-client.ts'),
            'utf8',
        )
        expect(source).toMatch(/attachStacktrace:\s*false/)
    })

    it.each([
        ['off', false, false],
        ['on (the v11 default)', true, true],
    ])(
        'with attachStacktrace %s, a captureMessage event carries a stack: %s',
        async (_label, attachStacktrace, expectsStack) => {
            const events: Sentry.ErrorEvent[] = []
            const client = new Sentry.NodeClient({
                dsn: 'https://key@sentry.example/1',
                attachStacktrace,
                integrations: [],
                stackParser: Sentry.defaultStackParser,
                transport: () => ({
                    send: async () => ({}),
                    flush: async () => true,
                }),
                beforeSend: event => {
                    events.push(event)
                    return null
                },
            })
            const scope = new Sentry.Scope()
            scope.setClient(client)
            client.init()
            scope.captureMessage(
                'Disallowed extension OAuth redirect URI',
                'warning',
            )
            await client.flush(2000)
            expect(events).toHaveLength(1)
            expect(events[0]?.message).toBe(
                'Disallowed extension OAuth redirect URI',
            )
            expect(Boolean(events[0]?.exception)).toBe(expectsStack)
        },
        30_000,
    )
})
