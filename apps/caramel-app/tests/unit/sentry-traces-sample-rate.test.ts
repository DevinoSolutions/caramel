import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The self-hosted Sentry's nginx gives each project one intake bucket
// (5 envelopes/s, burst 30) for errors AND transactions. With
// tracesSampleRate 1 Caramel's transactions kept that bucket empty and error
// envelopes were refused with 429 and lost (2026-09-26: 15 of 31, then 0 of
// 20 drill errors reached Sentry). A rate back at 1 would bring that back.
const CEILING = 0.1
const app = join(__dirname, '..', '..')

describe('Sentry tracing leaves room for errors in the shared intake bucket', () => {
    it.each(['sentry.common.config.ts', 'src/instrumentation-client.ts'])(
        '%s samples at most 10% of transactions',
        file => {
            const source = readFileSync(join(app, file), 'utf8')
            const rates = [
                ...source.matchAll(/tracesSampleRate:\s*([0-9.]+)/g),
            ].map(m => Number(m[1]))
            expect(rates.length).toBeGreaterThan(0)
            for (const rate of rates) expect(rate).toBeLessThanOrEqual(CEILING)
        },
    )
})
