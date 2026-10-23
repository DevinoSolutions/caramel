import {
    consumeAnonymousWriteQuota,
    quotaKeyFor,
    resetAnonymousWriteQuotas,
} from '@/lib/anonymousWriteQuota'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it } from 'vitest'

// T-6224 / T-6225 — the per-address hourly quota must not be rotatable by a
// host that owns a whole IPv6 /64.
beforeEach(() => {
    resetAnonymousWriteQuotas()
})

function from(ip: string) {
    return new NextRequest('http://localhost/api/sources', {
        method: 'POST',
        headers: { 'cf-connecting-ip': ip },
    })
}

describe('quotaKeyFor', () => {
    it('IPv4 is unchanged', () => {
        expect(quotaKeyFor('203.0.113.7')).toBe('203.0.113.7')
        expect(quotaKeyFor('203.0.113.8')).toBe('203.0.113.8')
    })

    it('two addresses in the same /64 share a key, however they are spelled', () => {
        const key = quotaKeyFor('2001:db8:1:2:aaaa:bbbb:cccc:dddd')
        expect(key).toBe('2001:db8:1:2::/64')
        expect(quotaKeyFor('2001:db8:1:2::1')).toBe(key)
        expect(quotaKeyFor('2001:0DB8:0001:0002:0:0:0:ffff')).toBe(key)
        expect(quotaKeyFor('[2001:db8:1:2::1]')).toBe(key)
    })

    it('different /64s get different keys', () => {
        expect(quotaKeyFor('2001:db8:1:2::1')).not.toBe(
            quotaKeyFor('2001:db8:1:3::1'),
        )
    })

    it('compressed forms expand correctly', () => {
        expect(quotaKeyFor('::1')).toBe('0:0:0:0::/64')
        expect(quotaKeyFor('2001:db8::1')).toBe('2001:db8:0:0::/64')
        expect(quotaKeyFor('fe80::1%eth0')).toBe('fe80:0:0:0::/64')
    })

    it('an IPv4-mapped IPv6 address is the IPv4 address', () => {
        expect(quotaKeyFor('::ffff:203.0.113.7')).toBe('203.0.113.7')
        // The hex spellings of the same mapped address (a dotted-only regex
        // sent these to the shared 0:0:0:0::/64 bucket).
        expect(quotaKeyFor('::ffff:cb00:7107')).toBe('203.0.113.7')
        expect(quotaKeyFor('0:0:0:0:0:ffff:cb00:7107')).toBe('203.0.113.7')
        expect(quotaKeyFor('::FFFF:CB00:7107')).toBe('203.0.113.7')
        expect(quotaKeyFor('::ffff:0102:0304')).toBe('1.2.3.4')
        expect(quotaKeyFor('0:0:0:0:0:ffff:102:304')).toBe('1.2.3.4')
    })

    it('no address, or garbage, shares the unknown bucket', () => {
        expect(quotaKeyFor(null)).toBe('unknown')
        expect(quotaKeyFor('')).toBe('unknown')
        expect(quotaKeyFor('not-an-ip')).toBe('unknown')
    })
})

describe('consumeAnonymousWriteQuota', () => {
    it('rotating through one /64 spends ONE quota; another /64 and IPv4 are separate', async () => {
        for (let i = 1; i <= 5; i += 1) {
            const result = await consumeAnonymousWriteQuota(
                from(`2001:db8:1:2::${i}`),
                'sources',
            )
            expect(result.allowed).toBe(true)
        }
        const sixth = await consumeAnonymousWriteQuota(
            from('2001:db8:1:2:dead:beef:0:1'),
            'sources',
        )
        expect(sixth.allowed).toBe(false)

        for (const ip of ['2001:db8:1:3::1', '203.0.113.7']) {
            expect(
                (await consumeAnonymousWriteQuota(from(ip), 'sources')).allowed,
            ).toBe(true)
        }
    })

    it('IPv4 addresses keep separate quotas', async () => {
        for (let i = 0; i < 5; i += 1) {
            await consumeAnonymousWriteQuota(from('203.0.113.7'), 'sources')
        }
        expect(
            (await consumeAnonymousWriteQuota(from('203.0.113.7'), 'sources'))
                .allowed,
        ).toBe(false)
        expect(
            (await consumeAnonymousWriteQuota(from('203.0.113.8'), 'sources'))
                .allowed,
        ).toBe(true)
    })
})
