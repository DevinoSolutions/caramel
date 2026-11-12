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
        'Sendly',
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
            'only after you tap to apply codes',
            "the store's hostname and a trimmed outline",
            'every digit is replaced with "#"',
            'email-shaped text is replaced with a placeholder',
            'every word that is not on a fixed list',
            'never contains text you typed into fields',
            "Devino's own AI model proxy",
            "which currently passes the request to NVIDIA's hosted model service (NIM)",
            'The only other page content the extension sends is the trimmed cart-page outline described under “Finding the promo-code box on a cart page” and, if you are signed in, the coupon box locations described under “Coupon boxes the extension finds”, each only as described there.',
            'Effective Date: November 10, 2026',
            'for that store and page shape',
            'Your IP address is used to rate-limit these requests.',
        ]) {
            expect(normalized).toContain(claim)
        }
    })

    it('carries the owner-approved coupon-report hash disclosure verbatim (approved 2026-10-21) and no longer claims anonymous-only totals', () => {
        const normalized = text.replace(/\s+/g, ' ')
        expect(normalized).toContain(
            'Coupon results are kept as per-code totals (when a code last worked or failed, and the store’s last error message). To stop fake reports from hiding or reviving a code, each “worked” or “didn’t work” report also keeps a one-way keyed hash of your IP address, or of your account if you are signed in. It cannot be turned back into your IP or account, and it is deleted after 30 days.',
        )
        expect(normalized).not.toContain('only as anonymous per-code totals')
    })

    it('carries the owner-approved checkout code sharing sentence verbatim (approved 2026-10-06)', () => {
        const normalized = text.replace(/&quot;/g, '"').replace(/\s+/g, ' ')
        expect(normalized).toContain(
            "Coupon codes you choose to share. If you're signed in, you can add a code on a store page, and, if the extension's \"Share codes I enter at checkout\" setting is on, the extension sends a code you typed yourself once the store accepts it. We store only the code, the store, and your account (to limit abuse); never your cart, order or payment details. Shared codes are shown publicly to other shoppers without your name. You can turn checkout sharing off at any time in the extension's settings.",
        )
        expect(normalized).not.toContain('is not switched on yet')
    })

    it('discloses the coupon box proposals a signed-in extension sends (T-15470, wording delegated 2026-11-10)', () => {
        const normalized = text.replace(/&quot;/g, '"').replace(/\s+/g, ' ')
        for (const claim of [
            "Coupon boxes the extension finds. If you're signed in and the extension finds the coupon field on a store we have no setup for, and a code you applied there lowered your total, it sends us that store's web address and the page locations of its coupon field, apply button and total, linked to your account.",
            'Never the code, your cart, order or payment details.',
            'We delete it 30 days after the extension last sent it, or when you delete your account, and it is included in your data export.',
            'sends the box locations described under "Coupon boxes the extension finds" below.',
        ]) {
            expect(normalized).toContain(claim)
        }
    })

    it('covers coupon boxes, store requests and shared codes in retention and deletion (T-12703, wording delegated 2026-11-10)', () => {
        const normalized = text.replace(/\s+/g, ' ')
        for (const claim of [
            'account-linked coupon results and the coupon boxes the extension found are kept until you delete them or ask us to delete your account; coupon boxes are also deleted 30 days after the extension last sent them.',
            'Codes you shared and stores you asked us to add stay after that, without your account, email or browser type on them.',
            'delete your saved Caramel data (savings, favorite stores, coupon results and the coupon boxes the extension found; this also removes your account, email and browser type from your store requests and unlinks you from codes you shared)',
            'coupon results and the coupon boxes the extension found, removes your account, email and browser type from your store requests, and unlinks you from codes you shared.',
        ]) {
            expect(normalized).toContain(claim)
        }
    })

    it('lists the synced checkout code-sharing choice as its own browser-storage item, next to the unchanged settings item (T-17452, wording pending owner review)', () => {
        const normalized = text.replace(/\s+/g, ' ')
        // The owner-approved settings sentence stays exactly as it was.
        expect(normalized).toContain(
            'Your settings, kept in your browser’s extension storage. If you use your browser’s sync feature, your browser syncs them to your other devices.',
        )
        expect(normalized).toContain(
            'Your checkout code-sharing choice (Share codes or No thanks, when you chose, and which version of the prompt you saw), kept in your browser’s extension storage. In Chrome it follows your Google profile: other computers where you are signed in to Chrome with sync on use the same choice, and Google stores it as part of your Chrome Sync data. In Firefox on a computer it syncs through your Firefox account when Add-ons sync is on.',
        )
    })
})
