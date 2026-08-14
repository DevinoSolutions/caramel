import SupportNotificationTemplate from '@/emails/SupportNotificationTemplate'
import { render } from '@react-email/render'
import { describe, expect, it } from 'vitest'

// The support notification is the email the owner reads every time a user
// reports something, and until 2026-08-14 it was the plain-text body dropped
// straight into the HTML slot: newlines collapsed, no styling, user input
// unescaped. These pin the three properties that fixes it — it is real HTML,
// the author's line breaks survive, and nothing a user types becomes markup.

const BASE = {
    feedbackId: '0610c6dd-8dfe-4d75-9319-2044809345ac',
    feedbackType: 'problem',
    wantsReply: true,
    message: 'first line\nsecond line',
    appLabel: 'caramel v0.1.0',
    environment: 'production',
    platform: 'web',
    route: '/support',
    userLabel: '33ce6015-1d08-4195-a96d-e80f01ddaefb',
    posthogSessionId: '01a00045-caae-77f0-bc02-e7f836409f00',
    posthogDistinctId: '33ce6015-1d08-4195-a96d-e80f01ddaefb',
}

const renderTemplate = (overrides: Record<string, unknown> = {}) =>
    render(SupportNotificationTemplate({ ...BASE, ...overrides } as never))

describe('support notification template', () => {
    it('renders a styled HTML document, not the plain-text body', async () => {
        const html = await renderTemplate()

        expect(html).toContain('<table')
        expect(html).toContain('style=')
        // Proof it rides the SHARED EmailLayout rather than inventing a look:
        // the layout's page background, its card border, and its logo.
        expect(html).toContain('#fdf8f5')
        expect(html).toContain('#f0e4db')
        expect(html).toContain('https://grabcaramel.com/full-logo.png')
    })

    it('preserves the author’s line breaks instead of collapsing them', async () => {
        const html = await renderTemplate({ message: 'first line\nsecond' })

        expect(html).toContain('<br')
        expect(html).toContain('first line')
        expect(html).toContain('second')
    })

    it('escapes user input so a report can never inject markup', async () => {
        const html = await renderTemplate({
            message: '<script>alert("xss")</script>',
            expectedOutcome: '<img src=x onerror=alert(1)>',
        })

        expect(html).not.toContain('<script>alert')
        expect(html).not.toContain('<img src=x onerror')
        expect(html).toContain('&lt;script&gt;')
        expect(html).toContain('&lt;img')
    })

    it('shows every field an operator needs to triage', async () => {
        const html = await renderTemplate({
            expectedOutcome: 'coupons should load',
        })

        for (const value of [
            BASE.feedbackId,
            BASE.appLabel,
            BASE.environment,
            BASE.route,
            BASE.userLabel,
            BASE.posthogSessionId,
            BASE.posthogDistinctId,
            'first line',
            'coupons should load',
        ]) {
            expect(html).toContain(value)
        }
    })

    it('links the Sentry event when there is one, and omits the section otherwise', async () => {
        const withSentry = await renderTemplate({
            sentryEventId: 'abc123',
            sentryUrl:
                'https://devino.sentry.io/organizations/devino/issues/?query=abc123',
        })
        expect(withSentry).toContain(
            'https://devino.sentry.io/organizations/devino/issues/?query=abc123',
        )

        const without = await renderTemplate()
        expect(without).not.toContain('sentry.io')
    })

    it('tells the operator that replying reaches the customer, only when they asked for a reply', async () => {
        // The shared layout's default footer says "do not reply" — which is the
        // opposite of the truth here, because the route sets replyTo to the
        // customer whenever they asked for one.
        const wants = await renderTemplate({ wantsReply: true })
        expect(wants).toContain('goes straight to the customer')
        expect(wants).not.toContain('Please do not reply')

        const doesNot = await renderTemplate({ wantsReply: false })
        expect(doesNot).toContain('Please do not reply')
    })

    it('omits the expected-outcome section entirely when none was given', async () => {
        const html = await renderTemplate({ expectedOutcome: undefined })

        expect(html).not.toContain('Expected outcome')
        expect(html).not.toContain('(none provided)')
    })
})
