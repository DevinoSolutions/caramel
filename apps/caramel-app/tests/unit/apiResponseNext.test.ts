import { nextApiResponse } from '@/lib/apiResponseNext'
import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'

// Characterization pins (F-013) — lock CURRENT behavior of nextApiResponse
// (src/lib/apiResponseNext.ts) before its `data`/`error` params widen from
// `any` to `unknown`. env.API_ENCRYPTION_ENABLED is unset in the vitest env
// block (vitest.config.ts), so every case here exercises the plaintext
// (enc-off) branch — the encrypted branch is untouched by this finding.

function makeReq(url = 'http://localhost/api/test'): NextRequest {
    return new NextRequest(url)
}

describe('nextApiResponse', () => {
    it('200 (success): plaintext body carries status/message/data when provided', async () => {
        const res = nextApiResponse(makeReq(), 200, 'ok', { foo: 'bar' })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            status: 'success',
            message: 'ok',
            data: { foo: 'bar' },
        })
    })

    it('200 (success): omits message/data keys entirely when not passed', async () => {
        const res = nextApiResponse(makeReq(), 200)
        expect(await res.json()).toEqual({ status: 'success' })
    })

    it('400 (error): status flips to "error", error payload included when provided', async () => {
        const res = nextApiResponse(makeReq(), 400, 'bad request', null, {
            code: 'BAD',
        })
        expect(res.status).toBe(400)
        expect(await res.json()).toEqual({
            status: 'error',
            message: 'bad request',
            error: { code: 'BAD' },
        })
    })

    it('500 (error): status "error" even without an explicit error payload', async () => {
        const res = nextApiResponse(makeReq(), 500, 'boom')
        expect(res.status).toBe(500)
        expect(await res.json()).toEqual({ status: 'error', message: 'boom' })
    })

    it('falsy-but-defined data (0) is omitted — pins the truthy-spread semantics across the any->unknown widen', async () => {
        const res = nextApiResponse(makeReq(), 200, undefined, 0)
        expect(await res.json()).toEqual({ status: 'success' })
    })

    it('falsy-but-defined error ("") is omitted — same truthy-spread semantics on the error param', async () => {
        const res = nextApiResponse(makeReq(), 400, undefined, null, '')
        expect(await res.json()).toEqual({ status: 'error' })
    })

    it('array data (truthy object) is included whole, not spread element-wise', async () => {
        const res = nextApiResponse(makeReq(), 200, undefined, [1, 2, 3])
        expect(await res.json()).toEqual({ status: 'success', data: [1, 2, 3] })
    })
})
