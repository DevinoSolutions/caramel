import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Every Sentry event used to carry release: null, so "is this fixed in the
// deployed build?" had no answer. The build already knows its commit
// (BUILD_SHA, inlined by next.config.mjs and served by /api/version); the
// server/edge init (sentry.common.config.ts) and the browser init
// (src/instrumentation-client.ts) must report it as `release`.
const app = join(__dirname, '..', '..')
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
})

async function loadRelease(
    sha: string | undefined,
): Promise<string | undefined> {
    vi.resetModules()
    if (sha === undefined) vi.stubEnv('GIT_COMMIT_SHA', undefined)
    else vi.stubEnv('GIT_COMMIT_SHA', sha)
    const mod = await import('@/lib/buildInfo')
    return mod.SENTRY_RELEASE
}

describe('SENTRY_RELEASE', () => {
    it('is the build commit sha when the build resolved one', async () => {
        await expect(loadRelease(SHA)).resolves.toBe(SHA)
    })

    it('is undefined, not the string "unknown", when the build could not resolve a commit', async () => {
        await expect(loadRelease(undefined)).resolves.toBeUndefined()
    })
})

describe('every Sentry init sets release from SENTRY_RELEASE', () => {
    it.each(['sentry.common.config.ts', 'src/instrumentation-client.ts'])(
        '%s',
        file => {
            const source = readFileSync(join(app, file), 'utf8')
            expect(source).toMatch(/release:\s*SENTRY_RELEASE/)
            expect(source).toMatch(
                /import \{ SENTRY_RELEASE \} from '[^']*buildInfo'/,
            )
        },
    )
})

describe('the server init forwards the release to Sentry.init', () => {
    // 30s: the dynamic import of the config module is slow on a cold cache.
    it('passes release in the options (server and edge share this init)', async () => {
        vi.resetModules()
        vi.stubEnv('GIT_COMMIT_SHA', SHA)
        vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://key@sentry.example/1')
        vi.stubEnv('NODE_ENV', 'production')
        const init = vi.fn()
        vi.doMock('@sentry/nextjs', () => ({ init }))
        const { initSentry } = await import('../../sentry.common.config')
        initSentry()
        expect(init).toHaveBeenCalledTimes(1)
        expect(init.mock.calls[0]?.[0]).toMatchObject({ release: SHA })
        vi.doUnmock('@sentry/nextjs')
    }, 30_000)
})
