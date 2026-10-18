import { afterEach, expect, it, vi } from 'vitest'

// A paid-fallback key set while the base URL is OpenRouter itself (or any
// root but the Devino proxy) is never sent: safe, but it must not be invisible
// either. The real env reader warns once per process, never with the value.
// Its own file because the warning is once per module instance; env.ts parses
// process.env at import, so the reader is re-imported after the env is stubbed.

const SENTINEL_KEY = 'sk-or-v1-NEVERLOGTHIS000000000000000000'

afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
})

it('warns once, without the key, when the key is set but the base URL is not the proxy', async () => {
    vi.resetModules()
    vi.stubEnv('OPENROUTER_FALLBACK_API_KEY', SENTINEL_KEY)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { proxyFallbackHeaders } = await import('@/lib/proxy-fallback-env')

    // On the proxy the key is sent and nothing is wrong, so nothing warns.
    expect(proxyFallbackHeaders('https://proxyai.devino.ca/v1')).toMatchObject({
        'X-ORF-Fallback-Key': SENTINEL_KEY,
    })
    expect(warn).not.toHaveBeenCalled()

    expect(proxyFallbackHeaders('https://openrouter.ai/api/v1')).toEqual({})
    expect(proxyFallbackHeaders(undefined)).toEqual({})

    expect(warn).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(warn.mock.calls)).toContain(
        'OPENROUTER_FALLBACK_API_KEY',
    )
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SENTINEL_KEY)
})
