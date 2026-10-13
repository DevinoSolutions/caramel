// @vitest-environment jsdom
import {
    extractFirstTouch,
    FIRST_TOUCH_STORAGE_KEY,
    firstTouchCookieDomain,
    referrerDomain,
    registrableDomain,
} from '@/lib/analytics/firstTouch'
import { FIRST_TOUCH_COOKIE_NAME } from '@/lib/analytics/firstTouchRecord'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The cm_ft cookie half of first-touch capture (firstTouch.ts): write-once
// across visits, the self-referral / auth-hop referrer rules, the extra ad
// click ids, and the apex-domain derivation. firstTouch.test.ts keeps the
// original localStorage and param-mapping contract.

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }))
vi.mock('@sentry/nextjs', () => sentry)

function clearCookie(): void {
    document.cookie = `${FIRST_TOUCH_COOKIE_NAME}=; Max-Age=0; Path=/`
}

function readCookie(): string | null {
    const part = document.cookie
        .split('; ')
        .find(c => c.startsWith(`${FIRST_TOUCH_COOKIE_NAME}=`))
    return part ? part.slice(FIRST_TOUCH_COOKIE_NAME.length + 1) : null
}

describe('referrerDomain: self-referral and auth hops are not sources', () => {
    it('treats every host of our own registrable domain as ours', () => {
        for (const referrer of [
            'https://grabcaramel.com/pricing',
            'https://www.grabcaramel.com/',
            'https://dev.grabcaramel.com/x',
        ]) {
            expect(referrerDomain(referrer, 'grabcaramel.com')).toBeUndefined()
        }
        expect(
            referrerDomain('https://grabcaramel.com/', 'dev.grabcaramel.com'),
        ).toBeUndefined()
    })

    it('treats Google and Apple sign-in hops as pass-through, not as the source', () => {
        for (const referrer of [
            'https://accounts.google.com/',
            'https://appleid.apple.com/auth/authorize',
            'https://idmsa.apple.com/',
        ]) {
            expect(referrerDomain(referrer, 'grabcaramel.com')).toBeUndefined()
        }
    })

    it('still records a genuinely external referrer', () => {
        expect(
            referrerDomain(
                'https://news.ycombinator.com/item?id=1',
                'grabcaramel.com',
            ),
        ).toBe('news.ycombinator.com')
    })
})

describe('extractFirstTouch: ad click ids', () => {
    it('keeps msclkid, gbraid, wbraid and ttclid next to gclid and fbclid', () => {
        const record = extractFirstTouch({
            search: '?msclkid=m1&gbraid=g1&wbraid=w1&ttclid=t1&gclid=c1&fbclid=f1',
            pathname: '/',
            capturedAt: '2026-01-01T00:00:00.000Z',
        })
        expect(record).toMatchObject({
            msclkid: 'm1',
            gbraid: 'g1',
            wbraid: 'w1',
            ttclid: 't1',
            gclid: 'c1',
            fbclid: 'f1',
        })
    })
})

describe('registrableDomain / firstTouchCookieDomain', () => {
    it('collapses subdomains to the last two labels', () => {
        expect(registrableDomain('dev.grabcaramel.com')).toBe('grabcaramel.com')
        expect(registrableDomain('www.grabcaramel.com:443')).toBe(
            'grabcaramel.com',
        )
        expect(registrableDomain('grabcaramel.com')).toBe('grabcaramel.com')
    })

    it('leaves localhost and IP literals alone and gives them no cookie Domain', () => {
        expect(registrableDomain('localhost')).toBe('localhost')
        expect(registrableDomain('127.0.0.1')).toBe('127.0.0.1')
        expect(firstTouchCookieDomain('localhost')).toBeUndefined()
        expect(firstTouchCookieDomain('127.0.0.1')).toBeUndefined()
        expect(firstTouchCookieDomain('[::1]')).toBeUndefined()
    })

    it('shares one cookie across the apex, www and dev', () => {
        for (const host of [
            'grabcaramel.com',
            'www.grabcaramel.com',
            'dev.grabcaramel.com',
        ]) {
            expect(firstTouchCookieDomain(host)).toBe('.grabcaramel.com')
        }
    })
})

describe('captureFirstTouch: the cm_ft cookie', () => {
    beforeEach(() => {
        window.localStorage.clear()
        clearCookie()
        sentry.captureException.mockClear()
        // Fresh module per test: the capture memoises per page load.
        vi.resetModules()
    })

    it('writes the record as URL-encoded JSON on the first load', async () => {
        window.history.replaceState(
            {},
            '',
            '/stores/nike?utm_source=reddit&msclkid=m1',
        )
        const { captureFirstTouch } = await import('@/lib/analytics/firstTouch')

        const record = captureFirstTouch()

        const raw = readCookie()
        expect(raw).not.toBeNull()
        expect(JSON.parse(decodeURIComponent(raw ?? ''))).toEqual(record)
        expect(record).toMatchObject({ utm_source: 'reddit', msclkid: 'm1' })
    })

    it('is write-once: a later visit with other params never changes the cookie', async () => {
        window.history.replaceState({}, '', '/?utm_source=reddit')
        const first = await import('@/lib/analytics/firstTouch')
        first.captureFirstTouch()
        const written = readCookie()

        // A second page load: fresh module state, storage emptied, new params.
        vi.resetModules()
        window.localStorage.clear()
        window.history.replaceState({}, '', '/?utm_source=newsletter')
        const second = await import('@/lib/analytics/firstTouch')
        const record = second.captureFirstTouch()

        expect(record?.utm_source).toBe('reddit')
        expect(readCookie()).toBe(written)
    })

    it('rebuilds the cookie from a pre-cookie localStorage record, unchanged', async () => {
        const original = {
            utm_source: 'reddit',
            landing_path: '/',
            captured_at: '2026-01-01T00:00:00.000Z',
        }
        window.localStorage.setItem(
            FIRST_TOUCH_STORAGE_KEY,
            JSON.stringify(original),
        )
        window.history.replaceState({}, '', '/?utm_source=newsletter')
        const { captureFirstTouch } = await import('@/lib/analytics/firstTouch')

        expect(captureFirstTouch()).toEqual(original)
        expect(JSON.parse(decodeURIComponent(readCookie() ?? ''))).toEqual(
            original,
        )
    })

    it('reports an invalid cookie loudly, then treats it as absent', async () => {
        document.cookie = `${FIRST_TOUCH_COOKIE_NAME}=%7Bnot-json; Path=/`
        window.history.replaceState({}, '', '/?utm_source=reddit')
        const { captureFirstTouch } = await import('@/lib/analytics/firstTouch')

        expect(captureFirstTouch()?.utm_source).toBe('reddit')
        expect(sentry.captureException).toHaveBeenCalled()
    })
})
