import { readBodyCapped } from '@/lib/api/readBodyCapped'
import { describe, expect, it } from 'vitest'

// A size check after req.text() comes too late for a chunked body, which has
// no Content-Length: the whole body is in memory before anything measures it.
function chunked(chunks: number, size = 1024) {
    let pulled = 0
    const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
            pulled += 1
            if (pulled > chunks) controller.close()
            else controller.enqueue(new Uint8Array(size).fill(0x61))
        },
    })
    const req = new Request('http://localhost/x', {
        method: 'POST',
        body: stream,
        duplex: 'half',
    } as RequestInit)
    return { req, pulled: () => pulled }
}

describe('readBodyCapped', () => {
    it('stops reading a chunked body as soon as it passes the cap', async () => {
        const { req, pulled } = chunked(1024)
        expect(await readBodyCapped(req, 4 * 1024)).toEqual({ ok: false })
        expect(pulled()).toBeLessThan(20)
    })

    it('returns a body under the cap whole', async () => {
        const { req } = chunked(3)
        const r = await readBodyCapped(req, 4 * 1024)
        expect(r).toEqual({ ok: true, text: 'a'.repeat(3 * 1024) })
    })

    it('accepts a body exactly at the cap', async () => {
        const { req } = chunked(4)
        expect((await readBodyCapped(req, 4 * 1024)).ok).toBe(true)
    })

    it('refuses a declared Content-Length over the cap before reading', async () => {
        const req = new Request('http://localhost/x', {
            method: 'POST',
            headers: { 'content-length': '999999' },
            body: 'x',
        })
        expect(await readBodyCapped(req, 4 * 1024)).toEqual({ ok: false })
        expect(req.bodyUsed).toBe(false)
    })

    it('answers an empty string for a request with no body', async () => {
        const req = new Request('http://localhost/x', { method: 'POST' })
        expect(await readBodyCapped(req, 10)).toEqual({ ok: true, text: '' })
    })

    it('keeps multi-byte characters split across chunks intact', async () => {
        const bytes = new TextEncoder().encode('café ✓')
        const parts = [bytes.slice(0, 4), bytes.slice(4)]
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                const next = parts.shift()
                if (next) controller.enqueue(next)
                else controller.close()
            },
        })
        const req = new Request('http://localhost/x', {
            method: 'POST',
            body: stream,
            duplex: 'half',
        } as RequestInit)
        expect(await readBodyCapped(req, 100)).toEqual({
            ok: true,
            text: 'café ✓',
        })
    })
})
