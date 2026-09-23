// @vitest-environment jsdom
import AppsPageClient from '@/app/(marketing)/apps/AppsPageClient'
import { CROSS_APP_PROMOTIONS } from '@/app/(marketing)/apps/crossAppPromotions'
import { STORE_LISTINGS } from '@/app/(marketing)/apps/storeListings'
import { EXTENSION_STAMP_ATTRIBUTE } from '@/lib/surface/detectSurface'
import { SurfaceProvider } from '@/lib/surface/SurfaceProvider'
import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The /apps page through the real SurfaceProvider: badges + view/click
// events on the web surface; no badges and an "already installed" note when
// the extension has stamped <html> (fleet spec §A + §E).

const { trackMock } = vi.hoisted(() => ({ trackMock: vi.fn() }))
vi.mock('@/lib/analytics/growthEvents', () => ({ trackGrowthEvent: trackMock }))

function mount() {
    return render(
        <SurfaceProvider>
            <AppsPageClient />
        </SurfaceProvider>,
    )
}

describe('/apps page', () => {
    beforeEach(() => {
        trackMock.mockReset()
        document.documentElement.removeAttribute(EXTENSION_STAMP_ATTRIBUTE)
        Object.defineProperty(window.navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
            configurable: true,
        })
    })
    afterEach(() => cleanup())

    it('renders every listed store badge as a link, hoists the visitor browser, and fires apps_page_view once', async () => {
        mount()
        await waitFor(() =>
            expect(trackMock).toHaveBeenCalledWith('apps_page_view', {
                surface: 'web',
                platform: 'windows',
                browser: 'chrome',
            }),
        )
        expect(
            trackMock.mock.calls.filter(call => call[0] === 'apps_page_view')
                .length,
        ).toBe(1)

        for (const listing of STORE_LISTINGS) {
            const link = screen.getByRole('link', {
                name: listing.badge.accessibleName,
            })
            expect(link.getAttribute('href')).toBe(listing.href)
            expect(link.getAttribute('target')).toBe('_blank')
        }
        const cards = Array.from(document.querySelectorAll('li[data-platform]'))
        expect(cards[0]?.getAttribute('data-platform')).toBe('chrome')
        expect(cards[0]?.textContent).toContain('Your browser')
        expect(screen.queryByTestId('apps-installed-note')).toBeNull()
    })

    it('fires store_badge_click and crossapp_click with the store / target app', async () => {
        mount()
        await waitFor(() => expect(trackMock).toHaveBeenCalled())
        const chrome = STORE_LISTINGS.find(l => l.platform === 'chrome')
        if (!chrome) throw new Error('chrome listing missing')
        fireEvent.click(
            screen.getByRole('link', { name: chrome.badge.accessibleName }),
        )
        expect(trackMock).toHaveBeenCalledWith('store_badge_click', {
            store: 'chrome',
            browser: 'chrome',
        })

        const promo = CROSS_APP_PROMOTIONS[0]
        const promoLink = document.querySelector(
            `a[data-target-app="${promo.id}"]`,
        )
        if (!promoLink) throw new Error('promo link missing')
        expect(promoLink.getAttribute('href')).toBe(promo.href)
        fireEvent.click(promoLink)
        expect(trackMock).toHaveBeenCalledWith('crossapp_click', {
            target_app: promo.id,
            surface: 'web',
        })
    })

    it('shows no badge and an installed note where the extension already is, but still lists sibling apps', async () => {
        document.documentElement.setAttribute(
            EXTENSION_STAMP_ATTRIBUTE,
            '1.4.1',
        )
        mount()
        await waitFor(() =>
            expect(trackMock).toHaveBeenCalledWith(
                'apps_page_view',
                expect.objectContaining({ surface: 'extension' }),
            ),
        )
        expect(screen.getByTestId('apps-installed-note')).not.toBeNull()
        expect(document.querySelector('[data-growth="install"]')).toBeNull()
        for (const listing of STORE_LISTINGS) {
            expect(
                screen.queryByRole('link', {
                    name: listing.badge.accessibleName,
                }),
            ).toBeNull()
        }
        expect(document.querySelectorAll('a[data-target-app]').length).toBe(
            CROSS_APP_PROMOTIONS.length,
        )
    })
})
