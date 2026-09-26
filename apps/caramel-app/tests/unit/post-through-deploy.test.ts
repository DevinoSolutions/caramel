import {
    isDeployGapAnswer,
    postJsonThroughDeploy,
} from '@/lib/postThroughDeploy'
import { afterEach, describe, expect, it, vi } from 'vitest'

const answer = (status: number, contentType: string) =>
    new Response(contentType.includes('json') ? '{"error":"x"}' : '<html>', {
        status,
        headers: { 'content-type': contentType },
    })

afterEach(() => vi.unstubAllGlobals())

describe('isDeployGapAnswer: only answers that did not come from Caramel', () => {
    it.each([
        [404, 'text/html; charset=utf-8'],
        [502, 'text/html'],
        [503, 'text/plain'],
        [522, 'text/html'],
    ])('%i %s from in front of Caramel is a gap', (status, type) => {
        expect(isDeployGapAnswer(answer(status, type))).toBe(true)
    })

    it("421 is a gap even as JSON: the host's catch-all answers unknown hosts with it", () => {
        // Verbatim from the swap drill on the #273 deploy (2026-09-26).
        const misdirected = new Response('{"error":"misdirected_request"}', {
            status: 421,
            headers: { 'content-type': 'application/json' },
        })
        expect(isDeployGapAnswer(misdirected)).toBe(true)
    })

    it.each([
        [404, 'application/json'],
        [503, 'application/json'],
        [400, 'text/html'],
        [429, 'application/json'],
        [200, 'text/html'],
    ])('%i %s is an answer from Caramel itself', (status, type) => {
        expect(isDeployGapAnswer(answer(status, type))).toBe(false)
    })
})

describe('postJsonThroughDeploy', () => {
    it('returns a refusal from Caramel as it is, without retrying it', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(answer(400, 'application/json'))
        vi.stubGlobal('fetch', fetchMock)
        const sleep = vi.fn(async () => {})
        const res = await postJsonThroughDeploy('/api/x', { a: 1 }, { sleep })
        expect(res?.status).toBe(400)
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(sleep).not.toHaveBeenCalled()
    })

    it('re-sends the same body after a gap answer and reports the recovery once', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(answer(502, 'text/html'))
            .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)
        const onGap = vi.fn()
        const sleep = vi.fn(async () => {})
        const res = await postJsonThroughDeploy(
            '/api/x',
            { a: 1 },
            { sleep, onGap },
        )
        expect(res?.status).toBe(200)
        expect(
            fetchMock.mock.calls.map(c => (c[1] as RequestInit).body),
        ).toEqual(['{"a":1}', '{"a":1}'])
        expect(sleep).toHaveBeenCalledWith(1_000)
        expect(onGap).toHaveBeenCalledTimes(1)
        expect(onGap).toHaveBeenCalledWith({
            recovered: true,
            attempts: 2,
            lastStatus: 502,
        })
    })

    it('gives up with null after the last delay and reports it once', async () => {
        const fetchMock = vi
            .fn()
            .mockImplementation(async () => answer(404, 'text/html'))
        vi.stubGlobal('fetch', fetchMock)
        const onGap = vi.fn()
        const sleep = vi.fn(async () => {})
        const res = await postJsonThroughDeploy(
            '/api/x',
            {},
            { sleep, onGap, delaysMs: [10, 20] },
        )
        expect(res).toBeNull()
        expect(fetchMock).toHaveBeenCalledTimes(3)
        expect(sleep.mock.calls).toEqual([[10], [20]])
        expect(onGap).toHaveBeenCalledTimes(1)
        expect(onGap).toHaveBeenCalledWith({
            recovered: false,
            attempts: 3,
            lastStatus: 404,
        })
    })

    it('does not retry a network error: the route may have received the request', async () => {
        const fetchMock = vi
            .fn()
            .mockRejectedValue(new TypeError('Failed to fetch'))
        vi.stubGlobal('fetch', fetchMock)
        await expect(
            postJsonThroughDeploy('/api/x', {}, { sleep: async () => {} }),
        ).rejects.toThrow('Failed to fetch')
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })
})
