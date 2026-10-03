import PrivacyPolicy from '@/components/PrivacyPolicy'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

// The Chrome Web Store rejected Caramel 1.4.2 (2026-09-22, "Purple Nickel")
// because the privacy policy did not cover collection, use, storage and
// sharing of all the data the extension touches. These pins keep each of
// those sections, and every party data is shared with, on the page — a
// rewrite that drops one fails here instead of in the next store review.
// Rendered to static markup (no effects), so framer-motion's in-view
// animations never need an IntersectionObserver.
const html = renderToStaticMarkup(<PrivacyPolicy />)
const text = html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&apos;/g, "'")

describe('privacy policy coverage', () => {
    it.each([
        ['collection', 'What Information Do We Collect?'],
        ['use', 'How Do We Use Your Information?'],
        ['storage', 'Where Is It Stored, and for How Long?'],
        ['sharing', 'Who Do We Share It With?'],
        ['choices', 'Your Choices'],
    ])('has the %s section', (_, heading) => {
        expect(text).toContain(heading)
    })

    it.each([
        'OpenRouter',
        'Anthropic',
        'Google and Apple',
        'UseSend',
        'Amazon SES',
        'Cloudflare',
        'Google Analytics',
        'PostHog',
        'Sentry',
        'Other Caramel shoppers',
    ])('names %s', party => {
        expect(text).toContain(party)
    })

    it('discloses the per-page hostname lookup and the cart page summary', () => {
        expect(text).toContain("that page's hostname")
        expect(text).toContain('names of up to 6 items in your cart')
    })

    it('keeps the owner-approved checkout sharing wording and the Limited Use statement', () => {
        expect(text).toContain(
            'Shared codes are shown publicly to other shoppers without your name.',
        )
        expect(text).toContain('including the Limited Use requirements')
    })

    it('pins the retention, deletion and scope claims the owner-approved review added', () => {
        expect(text).toContain('kept for up to 90 days')
        expect(text).toContain('within 30 days')
        expect(text).toContain('http or https')
        expect(text).toContain('without your sign-in token')
        expect(text).toContain('your order number or order history')
        expect(text).not.toContain('your full browsing history')
        expect(text).toContain('store-request form')
        expect(text).toContain(
            'on every session where an error occurs (form fields are masked)',
        )
    })

    it('does not describe checkout code capture as live (server flag is off)', () => {
        expect(text).toContain('is not switched on yet')
    })
})
