import {
    buildProxyFallbackHeaders,
    fetchWithoutRedirects,
    MAX_FALLBACK_AFTER_SECONDS,
    MIN_PAID_PATH_DEADLINE_SECONDS,
    PAID_ANSWER_SECONDS,
} from '@/lib/proxy-fallback-headers'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

// The two canonical exports a future signed-in caller must use when it wires
// in through src/lib/proxy-fallback-env.ts (no request carries the key
// today): `fetchWithoutRedirects` for its request, and a client deadline of
// at least `MIN_PAID_PATH_DEADLINE_SECONDS`. Two real local servers and the
// real fetch; nothing leaves the machine.

const KEY = 'sk-or-v1-' + 'test000000000000000000000000'
const servers: Server[] = []

afterEach(async () => {
    await Promise.all(
        servers
            .splice(0)
            .map(
                server =>
                    new Promise<void>(resolve => server.close(() => resolve())),
            ),
    )
})

/** A local HTTP server that records each request's headers and answers with `answer`. */
async function listen(answer: {
    status: number
    headers: Record<string, string>
}): Promise<{ origin: string; received: IncomingHttpHeaders[] }> {
    const received: IncomingHttpHeaders[] = []
    const server = createServer((req, res) => {
        req.resume()
        req.on('end', () => {
            received.push(req.headers)
            res.writeHead(answer.status, answer.headers).end('{}')
        })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    const { port } = server.address() as AddressInfo
    return { origin: `http://127.0.0.1:${port}`, received }
}

describe('the paid-fallback request rules for a future signed-in caller', () => {
    it('a keyed request through fetchWithoutRedirects fails on a 307 to another host, which never sees the key; plain fetch would have handed it over', async () => {
        const elsewhere = await listen({
            status: 200,
            headers: { 'content-type': 'application/json' },
        })
        const redirectingProxy = await listen({
            status: 307,
            headers: { location: `${elsewhere.origin}/v1/chat/completions` },
        })
        const request = () => ({
            method: 'POST',
            headers: buildProxyFallbackHeaders({
                baseUrl: 'https://proxyai.devino.ca/v1',
                key: KEY,
                model: undefined,
                afterSeconds: undefined,
            }),
            body: '{}',
        })
        const url = `${redirectingProxy.origin}/v1/chat/completions`

        await expect(fetchWithoutRedirects(url, request())).rejects.toThrow()
        expect(redirectingProxy.received[0]?.['x-orf-fallback-key']).toBe(KEY)
        expect(elsewhere.received).toEqual([])

        // Why the helper exists: fetch strips only Authorization and cookies
        // on a cross-origin redirect, so a plain fetch forwards the key.
        await fetch(url, request())
        expect(elsewhere.received[0]?.['x-orf-fallback-key']).toBe(KEY)
    })

    it('a paid path needs a client deadline of at least the longest wait plus a paid answer, 20 seconds', () => {
        expect(MAX_FALLBACK_AFTER_SECONDS).toBe(12)
        expect(MIN_PAID_PATH_DEADLINE_SECONDS).toBe(
            MAX_FALLBACK_AFTER_SECONDS + PAID_ANSWER_SECONDS,
        )
        expect(MIN_PAID_PATH_DEADLINE_SECONDS).toBe(20)
    })
})
