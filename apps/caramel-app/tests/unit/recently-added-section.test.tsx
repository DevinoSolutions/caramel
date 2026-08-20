// @vitest-environment jsdom
import RecentlyAddedSection from '@/components/supported-site/recently-added-section'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

// The "Recently added" strip's rendering contract. The case that matters most
// is the EMPTY one: a "Recently added" heading standing over an empty grid
// would be a freshness claim the page cannot back, on the one page shoppers
// visit to find out whether we support their store. Mirrors coupon-card.test's
// jsdom + RTL shape (framer-motion renders plain elements under jsdom).
afterEach(cleanup)

const stores = [
    { site: 'publiclands.com', addedLabel: 'Added today' },
    { site: 'nastygal.com', addedLabel: 'Added yesterday' },
]

describe('RecentlyAddedSection', () => {
    it('renders one linked tile per store, each carrying its own freshness line', () => {
        render(<RecentlyAddedSection stores={stores} />)

        expect(
            screen.getByRole('heading', { name: /Recently added/ }),
        ).toBeDefined()
        expect(screen.getByText('Added today')).toBeDefined()
        expect(screen.getByText('Added yesterday')).toBeDefined()

        // Every tile is a link to that store's coupon page — the strip is a
        // way in, not a wall of names.
        const links = screen.getAllByRole('link')
        expect(links.map(a => a.getAttribute('href'))).toEqual([
            '/coupons/publiclands.com',
            '/coupons/nastygal.com',
        ])
    })

    it('renders NOTHING when there is nothing recent, heading included', () => {
        const { container } = render(<RecentlyAddedSection stores={[]} />)

        expect(container.innerHTML).toBe('')
        expect(screen.queryByText(/Recently added/)).toBeNull()
    })

    it('labels the section by its own heading for assistive tech', () => {
        const { container } = render(<RecentlyAddedSection stores={stores} />)

        const section = container.querySelector('section')
        const labelId = section?.getAttribute('aria-labelledby')
        expect(labelId).toBe('recently-added-heading')
        expect(container.querySelector(`#${labelId}`)?.tagName).toBe('H2')
    })
})
