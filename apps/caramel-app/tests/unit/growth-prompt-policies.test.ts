import { CROSS_APP_PROMOTIONS } from '@/app/(marketing)/apps/crossAppPromotions'
import {
    DEFAULT_SNOOZE_MS,
    pickPrompt,
    type PromptContext,
    type PromptHistory,
} from '@/lib/prompts/orchestrator'
import {
    CROSS_APP_MIN_VISITS,
    CROSS_APP_PROMPT,
    decideCrossApp,
} from '@/lib/prompts/policies/crossApp'
import {
    INSTALL_EXTENSION_PROMPT,
    decideInstallExtension,
    isValueMoment,
} from '@/lib/prompts/policies/installExtension'
import { GROWTH_PROMPTS } from '@/lib/prompts/registry'
import { describe, expect, it } from 'vitest'

// The two registered growth prompts (fleet spec §B slots 2 and 5) as pure
// policies, and the registry wiring that puts them under the orchestrator.

const NOW = 1_800_000_000_000
const fresh: PromptHistory = { lastShownAt: null, dismissals: 0 }

const context = (overrides: Partial<PromptContext> = {}): PromptContext => ({
    now: NOW,
    surface: 'web',
    platform: 'windows',
    browser: 'chrome',
    visits: 2,
    promptsEnabled: true,
    shownThisSession: false,
    pathname: '/',
    signedIn: false,
    hasExtensionActivity: null,
    ...overrides,
})

describe('install_extension policy', () => {
    it('shows on the web surface from the second visit for a listed browser', () => {
        expect(decideInstallExtension(context(), fresh)).toEqual({ show: true })
        expect(
            decideInstallExtension(context({ browser: 'firefox' }), fresh),
        ).toEqual({
            show: true,
        })
    })

    it('never shows where the extension already is', () => {
        expect(
            decideInstallExtension(context({ surface: 'extension' }), fresh),
        ).toMatchObject({ show: false, reason: 'surface_not_web' })
    })

    it('stays quiet on /apps, on auth pages, on phones, and for a browser with no listing', () => {
        expect(
            decideInstallExtension(context({ pathname: '/apps' }), fresh),
        ).toMatchObject({ reason: 'on_apps_page' })
        expect(
            decideInstallExtension(context({ pathname: '/login' }), fresh),
        ).toMatchObject({ reason: 'auth_page' })
        expect(
            decideInstallExtension(context({ browser: 'other' }), fresh),
        ).toMatchObject({ reason: 'no_listing_for_browser' })
        // An iPhone says Safari, but the Safari listing is the Mac App Store.
        expect(
            decideInstallExtension(
                context({ platform: 'ios', browser: 'safari' }),
                fresh,
            ),
        ).toEqual({ show: false, reason: 'platform_cannot_install' })
        expect(
            decideInstallExtension(
                context({ platform: 'android', browser: 'chrome' }),
                fresh,
            ),
        ).toEqual({ show: false, reason: 'platform_cannot_install' })
    })

    it('waits for the second visit unless the shopper is on a store coupon page', () => {
        expect(
            decideInstallExtension(context({ visits: 1 }), fresh),
        ).toMatchObject({
            reason: 'first_visit',
        })
        expect(
            decideInstallExtension(
                context({ visits: 1, pathname: '/coupons/nike.com' }),
                fresh,
            ),
        ).toEqual({ show: true })
        expect(isValueMoment('/coupons/nike.com')).toBe(true)
        expect(isValueMoment('/coupons')).toBe(false)
        expect(isValueMoment('/coupons/stores')).toBe(false)
        expect(isValueMoment('/coupons/stores/a')).toBe(false)
    })

    it('honours the snooze and the refusal cap', () => {
        expect(
            decideInstallExtension(context(), {
                lastShownAt: NOW - DEFAULT_SNOOZE_MS + 1,
                dismissals: 1,
            }),
        ).toMatchObject({ reason: 'snoozed' })
        expect(
            decideInstallExtension(context(), {
                lastShownAt: NOW - DEFAULT_SNOOZE_MS - 1,
                dismissals: 1,
            }),
        ).toEqual({ show: true })
        expect(
            decideInstallExtension(context(), {
                lastShownAt: NOW - DEFAULT_SNOOZE_MS * 10,
                dismissals: 3,
            }),
        ).toMatchObject({ reason: 'dismissed_for_good' })
    })

    it('links the card to the listing for the visitor browser', () => {
        const chrome = INSTALL_EXTENSION_PROMPT.content(context())
        expect(chrome.title).toBe('Get Caramel for Chrome')
        expect(chrome.acceptHref).toMatch(
            /^https:\/\/chromewebstore\.google\.com\//,
        )
        const safari = INSTALL_EXTENSION_PROMPT.content(
            context({ browser: 'safari' }),
        )
        expect(safari.acceptLabel).toBe('Add to Safari')
        expect(safari.acceptHref).toMatch(/^https:\/\/apps\.apple\.com\//)
    })
})

describe('cross_app policy', () => {
    it('shows from the third visit on any known surface, extension included', () => {
        expect(
            decideCrossApp(context({ visits: CROSS_APP_MIN_VISITS }), fresh),
        ).toEqual({ show: true })
        expect(
            decideCrossApp(
                context({ visits: CROSS_APP_MIN_VISITS, surface: 'extension' }),
                fresh,
            ),
        ).toEqual({ show: true })
        expect(decideCrossApp(context({ visits: 2 }), fresh)).toMatchObject({
            reason: 'too_early',
        })
    })

    it('stays quiet on /apps, on auth pages, when snoozed/refused, and with nothing to promote', () => {
        const ready = context({ visits: 5 })
        expect(
            decideCrossApp({ ...ready, pathname: '/apps' }, fresh),
        ).toMatchObject({ reason: 'on_apps_page' })
        expect(
            decideCrossApp({ ...ready, pathname: '/signup' }, fresh),
        ).toMatchObject({ reason: 'auth_page' })
        expect(
            decideCrossApp(ready, { lastShownAt: NOW - 1000, dismissals: 1 }),
        ).toMatchObject({ reason: 'snoozed' })
        expect(
            decideCrossApp(ready, { lastShownAt: null, dismissals: 3 }),
        ).toMatchObject({ reason: 'dismissed_for_good' })
        expect(decideCrossApp(ready, fresh, [])).toMatchObject({
            reason: 'no_promotions',
        })
    })

    it('promotes the first manifest-derived sibling app, with its canonical URL', () => {
        const card = CROSS_APP_PROMPT.content(context({ visits: 5 }))
        expect(CROSS_APP_PROMOTIONS.length).toBeGreaterThan(0)
        expect(card.title).toBe(
            `More from Devino: ${CROSS_APP_PROMOTIONS[0].name}`,
        )
        expect(card.acceptHref).toBe(CROSS_APP_PROMOTIONS[0].href)
        expect(card.body).toBe(CROSS_APP_PROMOTIONS[0].blurb)
    })
})

describe('registry', () => {
    it('registers exactly install_extension and cross_app, and the orchestrator ranks install first', () => {
        expect(GROWTH_PROMPTS.map(p => p.id).sort()).toEqual([
            'cross_app',
            'install_extension',
        ])
        const pick = pickPrompt(
            GROWTH_PROMPTS,
            context({ visits: 5 }),
            () => fresh,
        )
        expect(pick?.id).toBe('install_extension')
        const onExtension = pickPrompt(
            GROWTH_PROMPTS,
            context({ visits: 5, surface: 'extension' }),
            () => fresh,
        )
        expect(onExtension?.id).toBe('cross_app')
    })
})
