import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Next holds every request body the middleware might read in memory, up to
// experimental.proxyClientMaxBodySize, and silently truncates anything past
// it. The limit is lowered from Next's 10 MB default; this pins it so it can
// neither drift back up (memory per request) nor below the largest real body
// (a truncated catalog push or session-replay batch). Read as source: importing
// next.config.mjs pulls in the whole Sentry build wrapper.
describe('next.config proxyClientMaxBodySize', () => {
    const source = readFileSync(
        join(__dirname, '..', '..', 'next.config.mjs'),
        'utf8',
    )

    it('is set exactly once, to 4 MB', () => {
        const settings = source.match(/proxyClientMaxBodySize\s*:\s*[^,\n]+/g)
        expect(settings).toEqual(["proxyClientMaxBodySize: '4mb'"])
    })

    it('is not also set under its deprecated name (Next refuses both)', () => {
        expect(source).not.toMatch(/middlewareClientMaxBodySize\s*:/)
    })
})
