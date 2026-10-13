import { CLIENT_IP_HEADERS, readClientIp } from '@/lib/clientIp'
import { beforeAll, describe, expect, it, vi } from 'vitest'

// #256: Better Auth logged "Rate limiting could not determine a client IP"
// and keyed every visitor on one shared bucket per auth path, because its
// default `ipAddressHeaders` is `['x-forwarded-for']` alone and behind
// Cloudflare + Traefik that header is a multi-hop list it refuses to parse.
// The fix feeds it the SAME trusted order our own limiter uses. These pin
// that the two cannot drift apart.

// auth.ts builds its Prisma adapter and email senders at import time; none of
// that is under test, so give them inert stand-ins (and keep the heavy
// react-email renderer out of the import graph).
vi.mock('@/lib/prisma', () => ({ default: {} }))
vi.mock('@/lib/email', () => ({ sendEmail: vi.fn() }))
vi.mock('@react-email/render', () => ({ render: vi.fn() }))

describe('Better Auth client-IP configuration', () => {
    let auth: typeof import('@/lib/auth/auth').auth
    // The real auth module pulls in better-auth and the email templates; a
    // cold import is slow on a busy runner, so it gets its own timeout.
    beforeAll(async () => {
        ;({ auth } = await import('@/lib/auth/auth'))
    }, 180_000)

    it('reads the client IP from the shared header order, CF-Connecting-IP first', () => {
        // toEqual on the whole block also pins that IP tracking is not
        // switched off (disableIpTracking would disable per-IP limiting).
        expect(auth.options.advanced?.ipAddress).toEqual({
            ipAddressHeaders: [...CLIENT_IP_HEADERS],
        })
        expect(auth.options.advanced?.ipAddress?.ipAddressHeaders[0]).toBe(
            'cf-connecting-ip',
        )
    })
})

describe('readClientIp', () => {
    it('lets CF-Connecting-IP beat a spoofed X-Forwarded-For and the Traefik X-Real-IP', () => {
        expect(
            readClientIp(
                new Headers({
                    'cf-connecting-ip': '203.0.113.7',
                    'x-real-ip': '172.71.150.4',
                    'x-forwarded-for': '6.6.6.6, 172.71.150.4',
                }),
            ),
        ).toBe('203.0.113.7')
    })

    it('returns null when no header identifies the caller', () => {
        expect(readClientIp(new Headers())).toBeNull()
    })
})
