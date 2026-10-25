// @vitest-environment jsdom
import DeleteAccountPage, {
    metadata,
} from '@/app/(marketing)/delete-account/page'
import { GET as getLlmsFull } from '@/app/llms-full.txt/route'
import { GET as getLlms } from '@/app/llms.txt/route'
import { GET as getMarkdownTwin } from '@/app/md/[...path]/route'
import {
    DELETE_ACCOUNT_EMAIL,
    DELETE_ACCOUNT_PAGE_COPY,
    DELETE_ACCOUNT_PATH,
    DELETE_ACCOUNT_SECTIONS,
    GATED_ANALYTICS_DELETION,
    POSTHOG_EVENT_DELETION_CADENCE_VERIFIED,
    selectAnalyticsDeletionCopy,
} from '@/lib/marketing/deleteAccountContent'
import { DOCS_SECTIONS } from '@/lib/marketing/docsContent'
import { markdownText } from '@/lib/seo/markdownTwins/content'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

// /delete-account (T-7505): the web page Google Play requires for account
// deletion. Pins what a Play reviewer and a person with no app open need: the
// canonical URL, one H1, every way to delete (iOS, Android, email with the
// policy's 30 days), the deleted and kept lists, and a Markdown twin that
// carries the same copy. DRAFT wording: owner sign-off pending (see
// src/lib/marketing/deleteAccountContent.ts).

afterEach(cleanup)

// Whether retention expiry purges the stored snapshot data of a recording is
// unconfirmed (deleting one on our instance removes only its metadata). Until it
// is, no copy may say recordings are kept at most / deleted after N days, or
// that nothing is left behind.
function expectNoStrongerRecordingClaim(text: string): void {
    expect(text).not.toMatch(/at most 30 days|up to 30 days/i)
    expect(text).not.toMatch(/deleted after|until they expire/i)
    expect(text).not.toMatch(/no backlog/i)
}

async function twinText(): Promise<string> {
    const res = await getMarkdownTwin(
        new Request('https://grabcaramel.com/delete-account.md'),
        { params: Promise.resolve({ path: ['delete-account'] }) },
    )
    expect(res.status).toBe(200)
    return res.text()
}

describe('delete-account content', () => {
    it('has unique section ids and covers every way to delete plus both lists', () => {
        const ids = DELETE_ACCOUNT_SECTIONS.map(section => section.id)
        expect(new Set(ids).size).toBe(ids.length)
        expect(ids).toEqual([
            'on-the-website',
            'ios-app',
            'android-app',
            'browser-extension',
            'by-email',
            'what-is-deleted',
            'what-is-kept',
        ])
    })

    it('names the exact in-app paths and the email path with the 30 days the privacy policy states', () => {
        const all = JSON.stringify(DELETE_ACCOUNT_SECTIONS)
        expect(all).toContain('Open the Account tab.')
        expect(all).toContain(
            'Tap the Account and privacy icon in the top bar.',
        )
        expect(all).toContain('Tap Delete my account.')
        expect(all).toContain('Confirm with Delete account.')
        expect(all).toContain(
            'Email hello@devino.ca from the email address on your account',
        )
        expect(all).toContain('We act on deletion requests within 30 days.')
        expect(DELETE_ACCOUNT_EMAIL).toBe('hello@devino.ca')
        // The web path (profile deletion) comes first.
        expect(DELETE_ACCOUNT_SECTIONS[0].steps?.join(' ')).toContain(
            'Open Data & privacy. Click Delete my account.',
        )
        expect(all).toContain('chose to hide your email')
    })

    it('lists the records that stay, including the ones handled by other parties', () => {
        const kept = DELETE_ACCOUNT_SECTIONS.find(
            section => section.id === 'what-is-kept',
        )?.bullets?.join(' ')
        for (const claim of [
            'saved rules to be published, those rules',
            'It is not stored with your account or your IP address, and it is deleted after 30 days.',
            'The text of store searches is not written to them.',
            'Error records and session replays (Sentry), kept for 90 days',
            'by January 23, 2027 at the latest',
            'Analytics events that are not linked to your account',
            'Google Analytics',
            'support inbox',
            'Sendly and Amazon SES',
        ]) {
            expect(kept, claim).toContain(claim)
        }
        expect(kept).not.toContain('cannot be turned back')
    })

    // PostHog's bulk_delete removes the person at once, but on our instance the
    // job that deletes the EVENTS does not run yet (posthog-selfhost is adding a
    // weekly one). Until POSTHOG_EVENT_DELETION_CADENCE_VERIFIED is flipped after
    // that job is live and verified, no page may say the events are deleted or
    // give a time bound; it must say what is true and offer deletion on request.
    it('says only what is true about analytics deletion while the event-deletion job is unverified', () => {
        expect(POSTHOG_EVENT_DELETION_CADENCE_VERIFIED).toBe(false)
        const all = DELETE_ACCOUNT_SECTIONS.flatMap(section => [
            ...section.paragraphs,
            ...(section.bullets ?? []),
        ]).join(' ')
        expect(all).toContain(
            'Your analytics profile in our self-hosted PostHog. When you delete your account we delete it straight away.',
        )
        expect(all).toContain(
            'Analytics events already recorded under that profile are not yet removed automatically. Email hello@devino.ca and we will delete them.',
        )
        expect(all).not.toMatch(/weekly|finishes it in the background|queue/i)
        expect(all).not.toMatch(
            /PostHog[^.]*within (about )?(a |\d+ )?(days?|weeks?)/i,
        )
    })

    it('the post-fix sentence exists, is gated, and only the gate can render it', () => {
        expect(GATED_ANALYTICS_DELETION.policyChoice).toContain(
            'deleted by a weekly clean-up, within about a week',
        )
        expect(GATED_ANALYTICS_DELETION.deletedBullet).toContain(
            'a weekly clean-up deletes within about a week',
        )
        expect(selectAnalyticsDeletionCopy(true)).toBe(GATED_ANALYTICS_DELETION)
        expect(selectAnalyticsDeletionCopy(false)).not.toBe(
            GATED_ANALYTICS_DELETION,
        )
        expect(selectAnalyticsDeletionCopy(false).policyChoice).not.toMatch(
            /weekly|within/,
        )
    })

    it('describes recording retention with the unconfirmed-purge wording and nothing stronger', () => {
        const kept = DELETE_ACCOUNT_SECTIONS.find(
            section => section.id === 'what-is-kept',
        )?.bullets?.join(' ')
        expect(kept).toContain(
            'a sample of sessions is recorded, with every form field masked',
        )
        expect(kept).toContain(
            'Session recordings are removed from the product within 30 days, and their stored data is purged in a scheduled clean-up.',
        )
        const recordingBullet = DELETE_ACCOUNT_SECTIONS.flatMap(
            section => section.bullets ?? [],
        ).filter(bullet => /recording/i.test(bullet))
        expect(recordingBullet.length).toBeGreaterThan(0)
        for (const bullet of recordingBullet) {
            expectNoStrongerRecordingClaim(bullet)
        }
    })

    it('is linked from the docs hub privacy section', () => {
        const privacy = DOCS_SECTIONS.find(
            section => section.id === 'privacy-and-data',
        )
        expect(
            privacy?.links.some(link => link.href === DELETE_ACCOUNT_PATH),
        ).toBe(true)
    })
})

describe('/delete-account page', () => {
    it('declares the canonical https://grabcaramel.com/delete-account and the shared copy', () => {
        expect(DELETE_ACCOUNT_PATH).toBe('/delete-account')
        expect(metadata.alternates?.canonical).toBe(
            'https://grabcaramel.com/delete-account',
        )
        expect(metadata.title).toBe(DELETE_ACCOUNT_PAGE_COPY.title)
        expect(metadata.description).toBe(DELETE_ACCOUNT_PAGE_COPY.description)
        expect(DELETE_ACCOUNT_PAGE_COPY.description.length).toBeLessThanOrEqual(
            220,
        )
    })

    it('renders exactly one H1 and one H2 per section, with every paragraph, step and bullet', () => {
        render(<DeleteAccountPage />)
        const h1s = screen.getAllByRole('heading', { level: 1 })
        expect(h1s).toHaveLength(1)
        expect(h1s[0].textContent).toBe('Delete your Caramel account')
        expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(
            DELETE_ACCOUNT_SECTIONS.length,
        )
        for (const section of DELETE_ACCOUNT_SECTIONS) {
            const region = screen.getByRole('region', { name: section.heading })
            for (const text of [
                ...section.paragraphs,
                ...(section.steps ?? []),
                ...(section.bullets ?? []),
            ]) {
                expect(within(region).getByText(text)).toBeTruthy()
            }
        }
    })

    it('links the email address and the privacy policy', () => {
        render(<DeleteAccountPage />)
        expect(
            screen
                .getByRole('link', { name: 'Email hello@devino.ca' })
                .getAttribute('href'),
        ).toBe('mailto:hello@devino.ca')
        expect(
            screen
                .getByRole('link', { name: 'Privacy Policy' })
                .getAttribute('href'),
        ).toBe('/privacy')
    })
})

describe('/delete-account Markdown twin, sitemap source and llms documents', () => {
    it('serves the same sections with absolute links only', async () => {
        const text = await twinText()
        expect(
            text.startsWith(
                '[Canonical HTML](https://grabcaramel.com/delete-account)',
            ),
        ).toBe(true)
        expect(text).toMatch(/^# Delete your Caramel account$/m)
        for (const section of DELETE_ACCOUNT_SECTIONS) {
            expect(text).toContain(`## ${markdownText(section.heading)}`)
        }
        expect(text).toContain('1. Open the Caramel app')
        expect(text).toContain('- ' + markdownText('Your favorite stores.'))
        expect(text).toContain(
            '[Privacy Policy](https://grabcaramel.com/privacy)',
        )
        expect(text).not.toMatch(/\]\(\//)
    })

    it('llms.txt and llms-full.txt list the page', async () => {
        const link =
            '[Delete your account](https://grabcaramel.com/delete-account)'
        expect(await getLlms().text()).toContain(link)
        expect(await getLlmsFull().text()).toContain(link)
    })
})
