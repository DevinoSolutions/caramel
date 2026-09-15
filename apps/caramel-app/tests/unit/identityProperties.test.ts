import {
    buildIdentityPayload,
    compactProperties,
    identityPayloadSignature,
    resolveDisplayName,
    toIsoTimestamp,
} from '@/lib/analytics/identityProperties'
import { describe, expect, it } from 'vitest'

// Identity enrichment — the pure PostHog person-property builders. These pin
// the three rules the payload has to obey no matter what the session hands
// us: never send a value we don't have, never leak the email into an identity
// label, and keep the acquisition story in $set_once where PostHog will not
// let a later session overwrite it.

const CONTEXT = {
    app_id: 'caramel',
    app_version: '1.2.3',
    platform: 'web',
    environment: 'production',
    locale: 'en-CA',
    timezone: 'America/Toronto',
}

describe('compactProperties', () => {
    it('keeps real scalars and trims strings', () => {
        expect(
            compactProperties({
                email: '  shopper@example.com  ',
                count: 3,
                optedIn: false,
            }),
        ).toEqual({
            email: 'shopper@example.com',
            count: 3,
            optedIn: false,
        })
    })

    it('drops nullish, empty and placeholder values', () => {
        expect(
            compactProperties({
                a: null,
                b: undefined,
                c: '',
                d: '   ',
                e: 'undefined',
                f: 'NULL',
                g: Number.NaN,
            }),
        ).toEqual({})
    })

    it('drops non-scalars rather than sending an object as a property', () => {
        expect(
            compactProperties({ nested: { a: 1 }, list: [1, 2], kept: 'yes' }),
        ).toEqual({ kept: 'yes' })
    })
})

describe('resolveDisplayName', () => {
    it('prefers the full name, then first+last, then the username', () => {
        expect(resolveDisplayName({ id: 'u1', name: 'Ada Lovelace' })).toBe(
            'Ada Lovelace',
        )
        expect(
            resolveDisplayName({
                id: 'u1',
                name: '   ',
                firstName: 'Ada',
                lastName: 'Lovelace',
            }),
        ).toBe('Ada Lovelace')
        expect(resolveDisplayName({ id: 'u1', firstName: 'Ada' })).toBe('Ada')
        expect(resolveDisplayName({ id: 'u1', username: 'ada' })).toBe('ada')
    })

    it('NEVER falls back to the email', () => {
        expect(
            resolveDisplayName({ id: 'u1', email: 'ada@example.com' }),
        ).toBeUndefined()
    })
})

describe('toIsoTimestamp', () => {
    it('accepts Dates and date strings, rejects unusable values', () => {
        expect(toIsoTimestamp(new Date('2026-01-02T03:04:05.000Z'))).toBe(
            '2026-01-02T03:04:05.000Z',
        )
        expect(toIsoTimestamp('2026-01-02T03:04:05.000Z')).toBe(
            '2026-01-02T03:04:05.000Z',
        )
        expect(toIsoTimestamp('not-a-date')).toBeUndefined()
        expect(toIsoTimestamp(null)).toBeUndefined()
        expect(toIsoTimestamp(undefined)).toBeUndefined()
    })
})

describe('buildIdentityPayload', () => {
    const user = {
        id: '8f1d0f0a-0000-4000-8000-000000000001',
        email: 'shopper@example.com',
        name: 'Ada Lovelace',
        username: 'ada',
        createdAt: new Date('2026-01-02T03:04:05.000Z'),
    }

    it('sets the current profile, surface and account age', () => {
        const { set } = buildIdentityPayload({ user, context: CONTEXT })

        expect(set).toEqual({
            email: 'shopper@example.com',
            $email: 'shopper@example.com',
            name: 'Ada Lovelace',
            rc_app_user_id: user.id,
            app_id: 'caramel',
            app_version: '1.2.3',
            platform: 'web',
            environment: 'production',
            locale: 'en-CA',
            timezone: 'America/Toronto',
            user_created_at: '2026-01-02T03:04:05.000Z',
        })
    })

    it('maps the first-touch record onto the $set_once acquisition keys', () => {
        const { setOnce } = buildIdentityPayload({
            user,
            context: CONTEXT,
            firstTouch: {
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
            },
        })

        expect(setOnce).toEqual({
            signup_date: '2026-01-02T03:04:05.000Z',
            first_platform: 'web',
            first_app_version: '1.2.3',
            first_utm_source: 'reddit',
            first_utm_medium: 'social',
            first_utm_campaign: 'launch',
            first_utm_term: 'coupons',
            first_utm_content: 'hero',
            first_ref: 'partner-a',
            first_gclid: 'gcl-1',
            first_fbclid: 'fb-1',
            first_referrer_domain: 'www.reddit.com',
            first_landing_path: '/stores/nike',
        })
    })

    it('omits every key it has no value for (no empty strings, no placeholders)', () => {
        const payload = buildIdentityPayload({
            user: { id: 'u1', email: null, name: '   ' },
            context: {
                app_id: 'caramel',
                app_version: '1.2.3',
                platform: 'web',
            },
            firstTouch: null,
        })

        expect(payload.set).toEqual({
            rc_app_user_id: 'u1',
            app_id: 'caramel',
            app_version: '1.2.3',
            platform: 'web',
        })
        expect(payload.setOnce).toEqual({
            first_platform: 'web',
            first_app_version: '1.2.3',
        })
    })

    it('falls back to the identify time for signup_date when the account age is unknown', () => {
        const { setOnce } = buildIdentityPayload({
            user: { id: 'u1' },
            context: CONTEXT,
            identifiedAt: '2026-03-04T05:06:07.000Z',
        })

        expect(setOnce.signup_date).toBe('2026-03-04T05:06:07.000Z')
    })

    it('never puts the email anywhere near the identity label', () => {
        const { set } = buildIdentityPayload({
            user: { id: 'u1', email: 'shopper@example.com' },
            context: CONTEXT,
        })

        expect(set.name).toBeUndefined()
        expect(set.rc_app_user_id).toBe('u1')
    })
})

describe('identityPayloadSignature', () => {
    it('is stable across property insertion order', () => {
        const a = identityPayloadSignature('u1', {
            set: { email: 'a@example.com', platform: 'web' },
            setOnce: { first_platform: 'web' },
        })
        const b = identityPayloadSignature('u1', {
            set: { platform: 'web', email: 'a@example.com' },
            setOnce: { first_platform: 'web' },
        })

        expect(a).toBe(b)
    })

    it('changes when the person or a property changes', () => {
        const base = identityPayloadSignature('u1', {
            set: { email: 'a@example.com' },
            setOnce: {},
        })

        expect(
            identityPayloadSignature('u2', {
                set: { email: 'a@example.com' },
                setOnce: {},
            }),
        ).not.toBe(base)
        expect(
            identityPayloadSignature('u1', {
                set: { email: 'b@example.com' },
                setOnce: {},
            }),
        ).not.toBe(base)
    })
})
