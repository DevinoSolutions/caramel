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

    it('discloses what the coupon-box finder and server pick send (wording delegated 2026-10-13)', () => {
        const normalized = text.replace(/&quot;/g, '"').replace(/\s+/g, ' ')
        for (const claim of [
            'Finding the promo-code box on a cart page.',
            "Nothing new is sent to Caramel for that, except that the extension reads Caramel's feature switches",
            'if the box it found works, reports where the box is',
            'only after you tap to apply codes',
            "the store's hostname and a trimmed outline",
            'every digit is replaced with "#"',
            'email-shaped text is replaced with a placeholder',
            'every word that is not on a fixed list',
            'never contains text you typed into fields',
            "Devino's own AI model proxy",
            "which currently passes the request to NVIDIA's hosted model service (NIM)",
            'The only other page content the extension sends is the trimmed cart-page outline described under “Finding the promo-code box on a cart page” and the promo-code box locations described under “Remembering a promo-code box that worked”, and only as described there.',
            'Effective Date: October 16, 2026',
            'for that store and page shape',
            'Your IP address is used to rate-limit these requests.',
        ]) {
            expect(normalized).toContain(claim)
        }
    })

    it('discloses what a learned promo-code box report sends and keeps', () => {
        const normalized = text.replace(/&quot;/g, '"').replace(/\s+/g, ' ')
        for (const claim of [
            'Remembering a promo-code box that worked.',
            'and the store responds to a code typed into it',
            'short technical descriptions (CSS selectors)',
            'the random install ID the extension created when it was installed',
            'the same ID described under “How you first found Caramel” below',
            'These records do not contain the install ID or your IP address, only salted hashes',
            'made separately for each store with a secret key that we hold',
            'cannot be joined with the records for another store in our database',
            "they can contain text from that page's markup",
            'but never anything you typed or anything about you',
            'we could in principle recompute the hash for a known install ID; we do not do this.',
            'Apart from what the selectors name, these reports never include page text, and they never include codes, your cart, or your account.',
            'Promo-code box locations',
            'at most 5 boxes per store',
            'At most 50 installs are kept per box',
            'the only recent failure report from a network is never deleted',
            'A box nobody has confirmed for 30 days is no longer used.',
            'A box nobody has confirmed for 60 days is deleted with everything recorded about it',
            '60 days after that install last reported on it',
            'we keep a salted hash of the network part of your IP address on its own, tied to no store and no install, with the time, and delete it after 24 hours',
            'The network records kept to limit abuse are deleted after 24 hours.',
        ]) {
            expect(normalized).toContain(claim)
        }
        // Claims the code cannot back: a hash under a key we hold is not
        // unrecoverable, and the install ID can sit with an account.
        for (const overclaim of [
            'without being able to recover either',
            'we do not link these reports to your account',
            'they never contain what is in them',
            'the oldest are deleted first',
            // A failing install's record CAN be deleted to make room (a
            // second install on a network already counted).
            'never one whose last report was a failure',
        ]) {
            expect(normalized).not.toContain(overclaim)
        }
    })

    it('carries the owner-approved checkout code sharing sentence verbatim (approved 2026-10-06)', () => {
        const normalized = text.replace(/&quot;/g, '"').replace(/\s+/g, ' ')
        expect(normalized).toContain(
            "Coupon codes you choose to share. If you're signed in, you can add a code on a store page, and, if the extension's \"Share codes I enter at checkout\" setting is on, the extension sends a code you typed yourself once the store accepts it. We store only the code, the store, and your account (to limit abuse); never your cart, order or payment details. Shared codes are shown publicly to other shoppers without your name. You can turn checkout sharing off at any time in the extension's settings.",
        )
        expect(normalized).not.toContain('is not switched on yet')
    })
})
