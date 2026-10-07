import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Next.js loads browser instrumentation ONLY from `instrumentation-client.ts`.
// Under the old name `instrumentation.client.ts` the browser Sentry SDK never
// started, and nothing failed: the build, the tests and the server all looked
// fine while Sentry received 0 browser events for 90 days.
const src = join(__dirname, '..', '..', 'src')

describe('browser Sentry is wired through the file Next.js actually loads', () => {
    it('src/instrumentation-client.ts exists and initialises Sentry', () => {
        const file = join(src, 'instrumentation-client.ts')
        expect(existsSync(file)).toBe(true)
        expect(readFileSync(file, 'utf8')).toContain('Sentry.init(')
    })

    it('no client instrumentation hides under a name Next.js ignores', () => {
        expect(existsSync(join(src, 'instrumentation.client.ts'))).toBe(false)
    })
})
