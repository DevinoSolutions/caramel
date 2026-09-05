// @vitest-environment jsdom
import {
    extractFirstTouch,
    FIRST_TOUCH_STORAGE_KEY,
    referrerDomain,
} from '@/lib/analytics/firstTouch'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Identity enrichment — first-touch attribution capture. The record is the
// ONE thing in the whole identity payload that cannot be rebuilt later: the
// landing URL and the external referrer exist for exactly one page load. So
// these tests pin both halves — the pure param mapping, and the
// write-once/never-overwrite storage contract that keeps a user's original
// acquisition source from being rewritten by their next organic visit.
//
// jsdom because `captureFirstTouch` reads window.location / document.referrer
// / localStorage; the extractor itself takes plain strings and is pure.

describe('referrerDomain', () => {
    it('returns the hostname of an external referrer', () => {
        expect(referrerDomain('https://www.reddit.com/r/deals/x')).toBe(
            'www.reddit.com',
        )
    })

    it('ignores our own host (internal navigation is not an acquisition source)', () => {
        expect(
            referrerDomain('https://grabcaramel.com/stores', 'grabcaramel.com'),
        ).toBeUndefined()
    })

    it('ignores missing and unparseable referrers', () => {
        expect(referrerDomain('')).toBeUndefined()
        expect(referrerDomain(null)).toBeUndefined()
        expect(referrerDomain('not a url')).toBeUndefined()
    })
})

describe('extractFirstTouch', () => {
    it('maps every attribution param it finds', () => {
        expect(
            extractFirstTouch({
                search: '?utm_source=reddit&utm_medium=social&utm_campaign=launch&utm_term=coupons&utm_content=hero&ref=partner-a&gclid=gcl-1&fbclid=fb-1',
                pathname: '/stores/nike',
                referrer: 'https://www.reddit.com/r/deals',
                host: 'grabcaramel.com',
                capturedAt: '2026-01-01T00:00:00.000Z',
            }),
        ).toEqual({
            utm_source: 'reddit',
            utm_medium: 'social',
            utm_campaign: 'launch',
            utm_term: 'coupons',
            utm_content: 'hero',
            ref: 'partner-a',
            gclid: 'gcl-1',
            fbclid: 'fb-1',
            referrer_domain: 'www.reddit.com',
            landing_path: '/stores/nike',
            captured_at: '2026-01-01T00:00:00.000Z',
        })
    })

    it('records only the landing path for an organic visit', () => {
        expect(
            extractFirstTouch({
                search: '',
                pathname: '/',
                capturedAt: '2026-01-01T00:00:00.000Z',
            }),
        ).toEqual({
            landing_path: '/',
            captured_at: '2026-01-01T00:00:00.000Z',
        })
    })

    it('drops empty and placeholder param values', () => {
        expect(
            extractFirstTouch({
                search: '?utm_source=&utm_medium=undefined&utm_campaign=%20%20&utm_term=null',
                pathname: '/',
                capturedAt: '2026-01-01T00:00:00.000Z',
            }),
        ).toEqual({
            landing_path: '/',
            captured_at: '2026-01-01T00:00:00.000Z',
        })
    })

    it('caps an absurdly long value instead of storing it whole', () => {
        const record = extractFirstTouch({
            search: `?utm_campaign=${'x'.repeat(1000)}`,
            pathname: '/',
        })

        expect(record.utm_campaign).toHaveLength(255)
    })
})

describe('captureFirstTouch', () => {
    beforeEach(() => {
        window.localStorage.clear()
        // Fresh module per test: the capture memoises per page load, which is
        // exactly the behaviour under test and must not leak between cases.
        vi.resetModules()
    })

    it('writes the record on the first load and returns it', async () => {
        window.history.replaceState({}, '', '/stores/nike?utm_source=reddit')
        const { captureFirstTouch } = await import('@/lib/analytics/firstTouch')

        const record = captureFirstTouch()

        expect(record?.utm_source).toBe('reddit')
        expect(record?.landing_path).toBe('/stores/nike')
        expect(
            JSON.parse(
                window.localStorage.getItem(FIRST_TOUCH_STORAGE_KEY) ?? 'null',
            ),
        ).toEqual(record)
    })

    it('NEVER overwrites an existing record, however the visitor arrives later', async () => {
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
        expect(
            JSON.parse(
                window.localStorage.getItem(FIRST_TOUCH_STORAGE_KEY) ?? 'null',
            ),
        ).toEqual(original)
    })

    it('replaces a corrupt record instead of throwing', async () => {
        window.localStorage.setItem(FIRST_TOUCH_STORAGE_KEY, '{not json')
        window.history.replaceState({}, '', '/?utm_source=reddit')
        const { captureFirstTouch } = await import('@/lib/analytics/firstTouch')

        expect(captureFirstTouch()?.utm_source).toBe('reddit')
    })
})
