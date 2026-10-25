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
            'The only other page content the extension sends is the trimmed cart-page outline described under “Finding the promo-code box on a cart page”, and only as described there.',
            'Effective Date: October 25, 2026',
            'for that store and page shape',
            'Your IP address is used to rate-limit these requests.',
        ]) {
            expect(normalized).toContain(claim)
        }
    })

    it('carries the owner-approved coupon-report hash disclosure verbatim (approved 2026-10-21) and no longer claims anonymous-only totals', () => {
        const normalized = text.replace(/\s+/g, ' ')
        expect(normalized).toContain(
            'Coupon results are kept as per-code totals (when a code last worked or failed, and the store’s last error message). To stop fake reports from hiding or reviving a code, each “worked” or “didn’t work” report also keeps a one-way keyed hash of your IP address, or of your account if you are signed in. It is not stored with your account or your IP address, and it is deleted after 30 days.',
        )
        expect(normalized).not.toContain('only as anonymous per-code totals')
    })

    // DRAFT wording (2026-10-24, T-7842 / T-7505), pending owner sign-off. Each
    // pin is a claim the apps, the extension or the account-delete route make
    // true; change the sentence and the code evidence together.
    it('covers the iOS and Android apps, in-app account deletion and the web deletion page', () => {
        const normalized = text
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, '&')
            .replace(/\s+/g, ' ')
        for (const claim of [
            'the Caramel iOS and Android apps and the grabcaramel.com website collect',
            'Our Mobile Apps',
            'The iOS app',
            'The Android app',
            'The Caramel Safari extension is bundled with the app.',
            'The only Android permission it asks for is Internet access',
            'The apps contain no advertising or analytics tools of their own.',
            'Account → Delete my account on iOS',
            'Account and privacy icon → Delete my account (or the Account tab → Data & privacy → Delete my account)',
            'asks Apple to revoke the Sign in with Apple tokens',
            'Delete your account yourself: on grabcaramel.com at Profile → Data & privacy → Delete my account',
            'if you signed in with Apple and hid your email, delete your account yourself as above instead',
            'Android’s web view uses Google Safe Browsing',
            "the Android web view's Safe Browsing check",
            'it asks our server for a one-time code that works for 60 seconds',
            'A copy of your saved stores is kept on your device so alerts can run.',
            'signing out clears it from the device',
            'The app has four tabs: Deals, Search, Saved and Account.',
            'the text you type is sent to our server',
            'We do not write it to our application logs, and the access log of our own proxy is switched off.',
            'passes the request on and may briefly cache the response and keep its own request records',
            'Since October 25, 2026 we also remove search text from error reports and from the web addresses recorded in session replays before they are stored, and we mask what you type in session replays.',
            'A sample of sessions is also recorded in our self-hosted PostHog, with every form field masked.',
            'Session recordings are removed from the product within 30 days, and their stored data is purged in a scheduled clean-up.',
            'A sample of sessions is recorded in our self-hosted PostHog, with every form field masked. Session recordings are removed from the product within 30 days, and their stored data is purged in a scheduled clean-up.',
            'until they expire, 90 days after capture (by January 23, 2027 at the latest)',
            'The text of store searches is not written to them.',
            'Error records and session replays (Sentry) are kept for 90 days.',
            'Your analytics profile in our self-hosted analytics (PostHog) is deleted immediately. Events already recorded under it are not yet removed automatically; ask us at hello@devino.ca and we will delete them.',
        ]) {
            expect(normalized).toContain(claim)
        }
        // Whether retention expiry purges a recording's stored data is
        // unconfirmed: no sentence about recordings may say "at most" / "deleted
        // after" / "until they expire" (the 30-day keyed hash is a different claim).
        const recordingSentences = normalized
            .split(/(?<=[.!?])\s*(?=[A-Z“])/)
            .filter(sentence => /recording/i.test(sentence))
        expect(recordingSentences.length).toBeGreaterThan(0)
        for (const sentence of recordingSentences) {
            expect(sentence).not.toMatch(/at most 30 days|up to 30 days/i)
            expect(sentence).not.toMatch(/deleted after|until they expire/i)
            expect(sentence).not.toMatch(/no backlog/i)
        }
        expect(html).toContain('href="/delete-account"')
    })

    it('says the extension has no third-party analytics but sends opt-in diagnostics, and that site analytics also run inside the apps', () => {
        const normalized = text.replace(/\s+/g, ' ')
        expect(normalized).toContain(
            'no ads, no third-party trackers and no third-party analytics code. The only analytics it starts itself are the optional anonymous usage diagnostics described below',
        )
        expect(normalized).toContain(
            'the outcome event our server records for a promo-code box lookup, and the install ID and first-touch record sent when you sign in',
        )
        expect(normalized).not.toContain('no ads, no analytics and no third')
        expect(normalized).toContain(
            'including its pages shown inside our iOS and Android apps (but not in the extension)',
        )
        expect(normalized).toContain(
            'including its pages shown inside our apps, never from the extension',
        )
    })

    it('discloses the signed-in promo-box suggestion (hostname plus up to four selectors) and where it is kept', () => {
        const normalized = text.replace(/\s+/g, ' ')
        for (const claim of [
            'Promo-box suggestions, only while Caramel has this feature switched on.',
            "the store's hostname and up to four CSS selectors",
            'at most once per store in a browser session',
            'It never sends the code, the price, your cart or anything you typed.',
            'Promo-box suggestions (the store’s hostname and the selectors described above) are kept with your account. A suggestion older than 30 days no longer counts toward a store’s saved rules but is not deleted automatically; it is removed when you delete your account.',
        ]) {
            expect(normalized.replace(/&#x27;/g, "'")).toContain(claim)
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
