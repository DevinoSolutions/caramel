import { GET } from '@/app/.well-known/security.txt/route'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
    vi.useRealTimers()
})

describe('security.txt', () => {
    it('publishes the real support contact and RFC 9116 fields as UTF-8 text', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-10-22T12:34:56.000Z'))

        const response = GET()
        const body = await response.text()

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe(
            'text/plain; charset=utf-8',
        )
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(body.split('\n')).toEqual([
            'Contact: https://grabcaramel.com/support',
            'Expires: 2027-04-20T12:34:56.000Z',
            'Canonical: https://grabcaramel.com/.well-known/security.txt',
            'Preferred-Languages: en',
            '',
        ])
    })

    it('rolls Expires forward 180 days on every request, including after a long-running deployment', async () => {
        vi.useFakeTimers()
        const initialTime = new Date('2026-10-22T12:34:56.000Z')
        vi.setSystemTime(initialTime)
        const initialBody = await GET().text()

        const laterTime = new Date('2028-02-28T01:02:03.000Z')
        vi.setSystemTime(laterTime)
        const laterBody = await GET().text()

        expect(initialBody).toContain('Expires: 2027-04-20T12:34:56.000Z\n')
        expect(laterBody).toContain('Expires: 2028-08-26T01:02:03.000Z\n')
        const expiry = laterBody.match(/^Expires: (.+)$/m)?.[1]
        expect(expiry).toBeDefined()
        expect(Date.parse(expiry!) - laterTime.getTime()).toBe(
            180 * 24 * 60 * 60 * 1000,
        )
    })
})
