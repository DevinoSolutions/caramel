import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

// chat() is the request the coupon-box pick sends with the paid-fallback key.
// Two real local servers and the real fetch: a "proxy" that answers 307 to
// another host, and that other host. Nothing leaves the machine.
const { envMock } = vi.hoisted(() => ({
    envMock: {} as Record<string, unknown>,
}))
vi.mock('@/lib/env', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/env')>()
    Object.assign(envMock, actual.env)
    return { ...actual, env: envMock }
})

import { chat } from '@/lib/openrouter'

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

async function listen(answer: {
    status: number
    headers: Record<string, string>
    body: string
}): Promise<{ origin: string; received: IncomingHttpHeaders[] }> {
    const received: IncomingHttpHeaders[] = []
    const server = createServer((req, res) => {
        req.resume()
        req.on('end', () => {
            received.push(req.headers)
            res.writeHead(answer.status, answer.headers).end(answer.body)
        })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    const { port } = server.address() as AddressInfo
    return { origin: `http://127.0.0.1:${port}`, received }
}

const REPLY = JSON.stringify({ choices: [{ message: { content: '{}' } }] })

async function redirectingProxy() {
    const elsewhere = await listen({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: REPLY,
    })
    const proxy = await listen({
        status: 307,
        headers: { location: `${elsewhere.origin}/v1/chat/completions` },
        body: '',
    })
    envMock.OPENROUTER_API_URL = `${proxy.origin}/v1`
    envMock.OPENROUTER_API_KEY = 'proxy-key'
    return { proxy, elsewhere }
}

describe('chat() and the paid-fallback key', () => {
    it('a call carrying X-ORF-Fallback-Key fails on a redirect, and the other host never sees the key', async () => {
        const { proxy, elsewhere } = await redirectingProxy()
        await expect(
            chat([{ role: 'user', content: 'x' }], {
                headers: { 'X-ORF-Fallback-Key': KEY },
                timeoutMs: 5000,
            }),
        ).rejects.toThrow()
        expect(proxy.received[0]?.['x-orf-fallback-key']).toBe(KEY)
        expect(elsewhere.received).toEqual([])
    })

    it('a call without the key still follows the redirect, as before', async () => {
        const { elsewhere } = await redirectingProxy()
        await expect(
            chat([{ role: 'user', content: 'x' }], {
                headers: { 'X-ORF-Strict': '1' },
                timeoutMs: 5000,
            }),
        ).resolves.toBe('{}')
        expect(elsewhere.received).toHaveLength(1)
    })
})
