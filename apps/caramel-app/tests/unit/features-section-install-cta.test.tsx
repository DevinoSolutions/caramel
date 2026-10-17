// @vitest-environment jsdom
import FeaturesSection from '@/components/FeaturesSection'
import { SurfaceProvider } from '@/lib/surface/SurfaceProvider'
import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The homepage browser buttons are the biggest install surface; they must
// report install_cta_click (placement home_features). growthEvents is a TEST
// DOUBLE (trackMock).
const { trackMock } = vi.hoisted(() => ({ trackMock: vi.fn() }))
vi.mock('@/lib/analytics/growthEvents', () => ({ trackGrowthEvent: trackMock }))

beforeEach(() => {
    trackMock.mockReset()
    Object.defineProperty(window.navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
        configurable: true,
    })
})
afterEach(cleanup)

describe('FeaturesSection install buttons', () => {
    it('fires install_cta_click with the store and home_features', async () => {
        render(
            <SurfaceProvider>
                <FeaturesSection />
            </SurfaceProvider>,
        )
        const firefox = await waitFor(() => screen.getByText('Firefox'))
        fireEvent.click(firefox)
        expect(trackMock).toHaveBeenCalledWith('install_cta_click', {
            store: 'firefox',
            placement: 'home_features',
        })
    })
})
