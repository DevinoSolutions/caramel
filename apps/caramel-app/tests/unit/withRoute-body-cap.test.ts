import { DEFAULT_MAX_BODY_BYTES, withRoute } from '@/lib/api/withRoute'
import {
    INGEST_CATALOG_MAX_BODY_BYTES,
    IngestCatalogPayloadSchema,
} from '@/lib/catalog/ingestSchemas'
import { NextRequest, NextResponse } from 'next/server'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

// T-6223 — withRoute used to `await req.json()` on every route that declares a
// `body`: an anonymous caller's 30 MB body was fully buffered, parsed and
// answered 200. The wrapper now reads no further than `maxBodyBytes` (default
// DEFAULT_MAX_BODY_BYTES) and answers 413 without running the handler.

vi.mock('@/lib/env', () => ({
    env: {
        CHROME_EXTENSION_ORIGIN: 'chrome-extension://known-id',
        FIREFOX_EXTENSION_ORIGIN: undefined,
        SAFARI_EXTENSION_ORIGIN: undefined,
        COUPONS_ADMIN_SECRET: 'test-admin-secret',
    },
}))
vi.mock('@sentry/nextjs', () => ({
    captureException: vi.fn(),
    setUser: vi.fn(),
    addBreadcrumb: vi.fn(),
}))

const Schema = z.object({ name: z.string().optional() })

function jsonRequest(body: BodyInit, headers: Record<string, string> = {}) {
    return new NextRequest(
        new Request('http://localhost/api/test', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body,
            duplex: 'half',
        } as RequestInit),
    )
}

/** A body of `totalChunks` 1 KiB chunks pulled only as the wrapper reads, with
 * NO Content-Length (a chunked upload). `pulled()` is how far it was read. */
function chunkedBody(totalChunks: number) {
    let pulled = 0
    const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
            pulled += 1
            if (pulled > totalChunks) controller.close()
            else controller.enqueue(new Uint8Array(1024).fill(0x20))
        },
    })
    return { stream, pulled: () => pulled }
}

describe('withRoute — request body cap (T-6223)', () => {
    it('refuses a declared Content-Length over the default cap, handler never runs', async () => {
        const handler = vi.fn(async () => NextResponse.json({ ok: true }))
        const route = withRoute(
            { method: 'POST', routeName: 'test', body: Schema },
            handler,
        )
        const res = await route(
            jsonRequest('{}', {
                'content-length': String(DEFAULT_MAX_BODY_BYTES + 1),
            }),
        )
        expect(res.status).toBe(413)
        expect(await res.json()).toEqual({ error: 'payload too large' })
        expect(handler).not.toHaveBeenCalled()
    })

    it('stops reading a chunked body with no Content-Length at the cap', async () => {
        const handler = vi.fn(async () => NextResponse.json({ ok: true }))
        const route = withRoute(
            { method: 'POST', routeName: 'test', body: Schema },
            handler,
        )
        // 4 MiB offered; the 64 KiB cap is passed on the 65th chunk.
        const { stream, pulled } = chunkedBody(4096)
        const res = await route(jsonRequest(stream))
        expect(res.status).toBe(413)
        // Never the whole body: the cap plus whatever the stream buffered ahead.
        expect(pulled()).toBeLessThan(200)
        expect(handler).not.toHaveBeenCalled()
    })

    it('cuts off a body whose Content-Length lies low', async () => {
        const route = withRoute(
            { method: 'POST', routeName: 'test', body: Schema },
            async () => NextResponse.json({ ok: true }),
        )
        const { stream, pulled } = chunkedBody(4096)
        const res = await route(jsonRequest(stream, { 'content-length': '10' }))
        expect(res.status).toBe(413)
        expect(pulled()).toBeLessThan(200)
    })

    it('accepts a body at the default cap and hands the parsed body on', async () => {
        const route = withRoute(
            { method: 'POST', routeName: 'test', body: Schema },
            async ({ body }) => NextResponse.json({ name: body.name?.length }),
        )
        const padding = 'a'.repeat(
            DEFAULT_MAX_BODY_BYTES - '{"name":""}'.length,
        )
        const raw = JSON.stringify({ name: padding })
        expect(raw.length).toBe(DEFAULT_MAX_BODY_BYTES)
        const res = await route(jsonRequest(raw))
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ name: padding.length })
    })

    it('measures BYTES, not characters: a multibyte body under the char count is still over', async () => {
        const route = withRoute(
            { method: 'POST', routeName: 'test', body: Schema },
            async () => NextResponse.json({ ok: true }),
        )
        // 3 bytes per char: 30_000 chars is ~90 KB, over 64 KiB.
        const raw = JSON.stringify({ name: '€'.repeat(30_000) })
        expect(raw.length).toBeLessThan(DEFAULT_MAX_BODY_BYTES)
        const res = await route(jsonRequest(raw))
        expect(res.status).toBe(413)
    })

    it('maxBodyBytes raises the cap for a route that declares one', async () => {
        const route = withRoute(
            {
                method: 'POST',
                routeName: 'test',
                body: Schema,
                maxBodyBytes: 1024 * 1024,
            },
            async ({ body }) => NextResponse.json({ name: body.name?.length }),
        )
        const raw = JSON.stringify({ name: 'a'.repeat(500_000) })
        const res = await route(jsonRequest(raw))
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ name: 500_000 })
    })

    it('maxBodyBytes can also lower the cap', async () => {
        const route = withRoute(
            {
                method: 'POST',
                routeName: 'test',
                body: Schema,
                maxBodyBytes: 64,
            },
            async () => NextResponse.json({ ok: true }),
        )
        const res = await route(
            jsonRequest(JSON.stringify({ name: 'a'.repeat(100) })),
        )
        expect(res.status).toBe(413)
    })

    it('merges CORS onto the 413 so a preflight-passing extension can read it', async () => {
        const route = withRoute(
            {
                method: 'POST',
                routeName: 'test',
                cors: 'extension',
                body: Schema,
            },
            async () => NextResponse.json({ ok: true }),
        )
        const res = await route(
            jsonRequest('{}', {
                origin: 'chrome-extension://known-id',
                'content-length': String(DEFAULT_MAX_BODY_BYTES + 1),
            }),
        )
        expect(res.status).toBe(413)
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
            'chrome-extension://known-id',
        )
    })

    it('answers 400 (not a 500) when the body stream errors mid-read, and logs why', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const handler = vi.fn(async () => NextResponse.json({ ok: true }))
        const route = withRoute(
            { method: 'POST', routeName: 'test/stream', body: Schema },
            handler,
        )
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.error(new Error('client hung up'))
            },
        })
        const res = await route(jsonRequest(stream))
        expect(res.status).toBe(400)
        expect(handler).not.toHaveBeenCalled()
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('test/stream'),
        )
        warn.mockRestore()
    })

    it('unparseable JSON still falls through to the schema as {} (lenient schema -> 200)', async () => {
        const route = withRoute(
            { method: 'POST', routeName: 'test', body: Schema },
            async ({ body }) => NextResponse.json({ body }),
        )
        const res = await route(jsonRequest('not json {{{'))
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ body: {} })
    })

    it('parses a body that starts with a UTF-8 BOM, as req.json() did', async () => {
        const route = withRoute(
            { method: 'POST', routeName: 'test', body: Schema },
            async ({ body }) => NextResponse.json({ body }),
        )
        const bytes = new Uint8Array(
            Buffer.concat([
                Buffer.from([0xef, 0xbb, 0xbf]),
                Buffer.from('{"name":"x"}'),
            ]),
        )
        const res = await route(jsonRequest(bytes))
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ body: { name: 'x' } })
    })

    it('a route that declares no body never reads the stream', async () => {
        const route = withRoute(
            { method: 'POST', routeName: 'test' },
            async () => NextResponse.json({ ok: true }),
        )
        const { stream, pulled } = chunkedBody(4096)
        const res = await route(jsonRequest(stream))
        expect(res.status).toBe(200)
        expect(pulled()).toBeLessThan(5)
    })
})

describe('ingest/catalog cap (T-6223)', () => {
    it('is larger than the default, and never above the ceiling Next itself enforces on every body', () => {
        expect(INGEST_CATALOG_MAX_BODY_BYTES).toBeGreaterThan(
            DEFAULT_MAX_BODY_BYTES,
        )
        // next.config.mjs `experimental.proxyClientMaxBodySize: '4mb'`: past it
        // Next truncates the body before any route runs, so a larger route cap
        // would be unreachable. Read as text: next.config is not importable.
        const config = readFileSync(
            resolve(__dirname, '../../next.config.mjs'),
            'utf8',
        )
        const match = /proxyClientMaxBodySize:\s*'(\d+)mb'/.exec(config)
        expect(match, 'next.config.mjs proxyClientMaxBodySize').not.toBeNull()
        const nextCeilingBytes = Number(match?.[1]) * 1024 * 1024
        expect(INGEST_CATALOG_MAX_BODY_BYTES).toBeLessThanOrEqual(
            nextCeilingBytes,
        )
    })

    it('the payload schema refuses an array past its ceiling', () => {
        const row = {
            id: '1',
            code: 'A',
            site: 'a.com',
            title: 't',
            description: 'd',
            discount_type: null,
            discount_amount: null,
            expiry: null,
            verification_message: null,
            status: 'valid',
            updated_at: '2026-10-21T00:00:00.000Z',
        }
        const result = IngestCatalogPayloadSchema.safeParse({
            coupons: Array.from({ length: 100_001 }, () => row),
        })
        expect(result.success).toBe(false)
    })
})
