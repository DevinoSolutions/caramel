// /delete-account copy, as data. ONE module feeds the HTML page
// ((marketing)/delete-account/page.tsx) and its Markdown twin
// (markdownTwins/staticPages.ts), so the twin can never advertise a sentence
// the page does not render.
//
// CLAIM INTEGRITY (drafted 2026-10-24, T-7505): this is public privacy wording
// and needs owner sign-off before it merges. Every sentence restates what the
// code does; when one of these sources changes, change the sentence here too
// (the policy at src/components/PrivacyPolicy.tsx links here):
// - the website flow: src/app/profile/sections/DataPrivacySection.tsx
//   (Profile > Data & privacy > "Delete my account", type DELETE)
// - the in-app flows: apps/caramel-apple/App/Features/Account/AccountView.swift
//   (Account tab > "Delete my account" > "Delete account") and
//   apps/caramel-android/app/src/main/java/com/devino/caramel/ui/CaramelApp.kt
//   (top-bar "Account and privacy" icon > "Delete my account" > "Delete
//   account"; the Account tab shows /profile, ShellRoutes.kt ShellTab.ACCOUNT)
// - what is deleted and kept: POST /api/account/delete
//   (src/app/api/account/delete/route.ts) plus the foreign keys in
//   prisma/schema.prisma (the route adds no per-table deletes of its own)
// - the email path and its 30 days: src/components/PrivacyPolicy.tsx
//   ("Your Choices"); the by-hand steps are RUNBOOK.md "Privacy-policy
//   commitments" and must delete exactly what the lists below promise
// - the 30-day reporter hash, 90-day logs and Sentry, and the store-search
//   text rules (no app log, proxy access log off, scrubbed from Sentry since
//   2026-10-25): PrivacyPolicy.tsx "Where Is It Stored, and for How Long?"
// - the analytics deletion: src/lib/analytics/posthogPersonDeletion.ts. On our
//   self-hosted PostHog, bulk_delete removes the PERSON immediately, but the
//   EVENTS are only queued as AsyncDeletion rows, and the job that processes
//   them does not run on our instance yet (posthog-selfhost is adding a weekly
//   one, a Dokploy Schedule on the posthog compose, owner-managed, not a host
//   cron). See ANALYTICS_DELETION_COPY below.
export const DELETE_ACCOUNT_PATH = '/delete-account'

export const DELETE_ACCOUNT_EMAIL = 'hello@devino.ca'

// TODO(T-7505): GATE. Flip to true ONLY after posthog-selfhost's weekly
// event-deletion job is live AND verified on our instance (HogQL shows the
// events of a deleted person actually disappear). While false, every public
// page renders the interim sentences, which promise only what is true today:
// the profile is deleted at once, the events are not removed automatically,
// and we delete them on request (RUNBOOK.md "Account deletion: the PostHog
// person", step "events on request"). Until then no sentence may say the events
// are deleted, queued-and-finishing, or give a time bound (the unit tests
// enforce it).
export const POSTHOG_EVENT_DELETION_CADENCE_VERIFIED = false

type AnalyticsDeletionCopy = {
    /** One sentence for the policy's "Your Choices" email bullet. */
    policyChoice: string
    /** The /delete-account "What is deleted" bullet. */
    deletedBullet: string
    /** The /delete-account "What is kept" bullet, when something stays. */
    keptBullet: string | null
}

const INTERIM_ANALYTICS_DELETION: AnalyticsDeletionCopy = {
    policyChoice: `Your analytics profile in our self-hosted analytics (PostHog) is deleted immediately. Events already recorded under it are not yet removed automatically; ask us at ${DELETE_ACCOUNT_EMAIL} and we will delete them.`,
    deletedBullet:
        'Your analytics profile in our self-hosted PostHog. When you delete your account we delete it straight away.',
    keptBullet: `Analytics events already recorded under that profile are not yet removed automatically. Email ${DELETE_ACCOUNT_EMAIL} and we will delete them.`,
}

// TODO(T-7505): GATED. Drafted for the state after the weekly job is live and
// verified; rendered only when POSTHOG_EVENT_DELETION_CADENCE_VERIFIED is true.
export const GATED_ANALYTICS_DELETION: AnalyticsDeletionCopy = {
    policyChoice:
        'Your analytics profile in our self-hosted analytics (PostHog) is deleted immediately, and the events linked to it are deleted by a weekly clean-up, within about a week.',
    deletedBullet:
        'Your analytics profile in our self-hosted PostHog, which we delete straight away, and the events linked to it, which a weekly clean-up deletes within about a week.',
    keptBullet: null,
}

export function selectAnalyticsDeletionCopy(
    verified: boolean,
): AnalyticsDeletionCopy {
    return verified ? GATED_ANALYTICS_DELETION : INTERIM_ANALYTICS_DELETION
}

export const ANALYTICS_DELETION_COPY = selectAnalyticsDeletionCopy(
    POSTHOG_EVENT_DELETION_CADENCE_VERIFIED,
)

export const DELETE_ACCOUNT_PAGE_COPY = {
    title: 'Delete your Caramel account | Caramel',
    description:
        'How to delete your Caramel account on the website, in the iOS or Android app, or by email, what is deleted, and what is kept.',
    heading: 'Delete your Caramel account',
    summary:
        'You can delete your Caramel account on the website, in the iOS app or the Android app, or by emailing us. This page says how, what is deleted and what is kept.',
    privacyLead: 'For everything Caramel collects and why, see the',
    privacyLabel: 'Privacy Policy',
    emailLabel: 'Email hello@devino.ca',
} as const

type DeleteAccountSection = {
    id: string
    heading: string
    paragraphs: ReadonlyArray<string>
    /** Rendered as an ordered list after the paragraphs. */
    steps?: ReadonlyArray<string>
    /** Rendered as a bullet list after the paragraphs. */
    bullets?: ReadonlyArray<string>
    /** Adds the mailto link after the paragraphs. */
    emailLink?: true
}

export const DELETE_ACCOUNT_SECTIONS: ReadonlyArray<DeleteAccountSection> = [
    {
        id: 'on-the-website',
        heading: 'On the website',
        paragraphs: [
            'Deleting your account takes effect straight away, signs you out of every device and cannot be undone. You can download a copy of your data from the same page first.',
        ],
        steps: [
            'Sign in at grabcaramel.com and open your Profile (grabcaramel.com/profile).',
            'Open Data & privacy.',
            'Click Delete my account.',
            'Type DELETE and confirm with Delete my account.',
        ],
    },
    {
        id: 'ios-app',
        heading: 'In the iOS app',
        paragraphs: [
            'Deleting your account in the app takes effect straight away and cannot be undone.',
        ],
        steps: [
            'Open the Caramel app and sign in if you are not already signed in.',
            'Open the Account tab.',
            'Tap Delete my account.',
            'Confirm with Delete account.',
        ],
    },
    {
        id: 'android-app',
        heading: 'In the Android app',
        paragraphs: [
            'Deleting your account in the app takes effect straight away and cannot be undone.',
            'The app’s Account tab shows the same Profile page as the website, so you can also delete your account there: open the Account tab, then Data & privacy, then Delete my account.',
        ],
        steps: [
            'Open the Caramel app and sign in if you are not already signed in.',
            'Tap the Account and privacy icon in the top bar.',
            'Tap Delete my account.',
            'Confirm with Delete account.',
        ],
    },
    {
        id: 'browser-extension',
        heading: 'In the browser extension',
        paragraphs: [
            'The Caramel browser extension has no button that deletes your account. Use the website or one of the apps; deleting your account also signs the extension out.',
            'Data & privacy on the website also has a separate Delete my data button, which removes your savings, favorite stores and coupon results but keeps your account.',
        ],
    },
    {
        id: 'by-email',
        heading: 'By email',
        paragraphs: [
            'Email hello@devino.ca from the email address on your account and ask us to delete your account. We act on deletion requests within 30 days.',
            'If you signed in with Apple and chose to hide your email, you may not be able to write from that address: delete your account on the website or in an app instead.',
            'When you ask by email we delete the same records by hand, including your analytics profile in PostHog. The Sign in with Apple tokens are revoked automatically only when you delete your account yourself on the website or in an app.',
        ],
        emailLink: true,
    },
    {
        id: 'what-is-deleted',
        heading: 'What is deleted',
        paragraphs: ['When your account is deleted, these are removed:'],
        bullets: [
            'Your login: your email address, name and profile picture, your password (stored only as a one-way hash) and the link to your Google or Apple sign-in.',
            'Every sign-in session on every device (the apps, the extension and the website), including the IP address and browser type recorded with each session.',
            'Your favorite stores.',
            'Your savings history.',
            'The coupon results (worked or did not work) linked to your account.',
            'Promo-box suggestions your signed-in extension sent for a store, if that feature was switched on.',
            'Sign-in, email-verification and password-reset codes issued for your email address.',
            ANALYTICS_DELETION_COPY.deletedBullet,
            'The email address, the store address you typed and the browser type on any store request you made. The store request itself stays (see below).',
            'If you signed in with Apple and delete the account yourself: we ask Apple to revoke the Sign in with Apple tokens for your account.',
        ],
    },
    {
        id: 'what-is-kept',
        heading: 'What is kept',
        paragraphs: ['These are not deleted with your account:'],
        bullets: [
            'Coupon codes you shared stay published while they are valid. They are shown without your name and are no longer linked to you.',
            'The store and status of any store request you made, so the store can still be added. Your email address and browser type are removed from it.',
            'If several shoppers’ promo-box suggestions caused a store’s saved rules to be published, those rules (page-element selectors, not personal data) stay.',
            'Per-code coupon totals (when a code last worked or failed). They are not tied to you.',
            'A one-way keyed hash of your account (or of your IP address, for a result sent while signed out) is kept with each coupon result to stop fake reports. It is not stored with your account or your IP address, and it is deleted after 30 days.',
            'Server logs, which can include IP addresses and browser type, for up to 90 days. The text of store searches is not written to them.',
            // TODO(T-7505): confirm Sentry replay retention in sentry-selfhost before stating a duration for replays.
            'Error records (Sentry), kept for 90 days, and a sample of session replays (Sentry), kept for as long as our self-hosted Sentry retains them. They can hold your user id and the pages or errors you hit while signed in. Since our October 25, 2026 update they are stored without store-search text; error records captured before that update may contain it until they expire (by January 23, 2027 at the latest), and replays captured before it until Sentry deletes them.',
            ...(ANALYTICS_DELETION_COPY.keptBullet
                ? [ANALYTICS_DELETION_COPY.keptBullet]
                : []),
            // TODO(T-7505): recording retention sentence withheld (MASTER 2026-10-25) until posthog-selfhost confirms new recordings are stamped 30d and the storage purge (A78, T-8392) is done; do not add a duration or deletion claim before then.
            'Session recordings of your visits (a sample of sessions is recorded, with every form field masked) in our self-hosted PostHog.',
            'PostHog session recordings made before our October 25, 2026 update may contain store-search text.',
            'Analytics events that are not linked to your account: visits from before you signed in that were never joined to your account, and the extension’s install and anonymous diagnostic events.',
            'Usage data collected by Google Analytics on our website. Google holds it under its own retention settings; deleting your account does not remove it.',
            'Messages you sent to support (the support form or hello@devino.ca). They stay in our support inbox; deleting your account does not remove them. Include them in your email if you want them removed.',
            'Delivery records for the account emails we sent you (sign-up verification, password resets). Sendly and Amazon SES keep these under their own retention periods.',
        ],
    },
]
