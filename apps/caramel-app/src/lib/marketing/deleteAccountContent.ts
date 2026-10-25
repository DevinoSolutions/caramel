// /delete-account copy, as data. ONE module feeds the HTML page
// ((marketing)/delete-account/page.tsx) and its Markdown twin
// (markdownTwins/staticPages.ts), so the twin can never advertise a sentence
// the page does not render.
//
// CLAIM INTEGRITY (drafted 2026-10-24, T-7505): this is public privacy wording
// and needs owner sign-off before it merges. Every sentence restates what the
// code does; when one of these sources changes, change the sentence here too
// (the policy at src/components/PrivacyPolicy.tsx links here):
// - the in-app flows: apps/caramel-apple/App/Features/Account/AccountView.swift
//   (Account tab > "Delete my account" > "Delete account") and
//   apps/caramel-android/app/src/main/java/com/devino/caramel/ui/CaramelApp.kt
//   (top-bar "Account and privacy" icon > "Delete my account" > "Delete account")
// - what is deleted and kept: POST /api/account/delete
//   (src/app/api/account/delete/route.ts) plus the foreign keys in
//   prisma/schema.prisma (the route adds no per-table deletes of its own)
// - the email path and its 30 days: src/components/PrivacyPolicy.tsx
//   ("Your Choices"), RUNBOOK.md "Privacy-policy commitments"
// - the 30-day reporter hash and 90-day logs: PrivacyPolicy.tsx "Where Is It
//   Stored, and for How Long?"
export const DELETE_ACCOUNT_PATH = '/delete-account'

export const DELETE_ACCOUNT_EMAIL = 'hello@devino.ca'

export const DELETE_ACCOUNT_PAGE_COPY = {
    title: 'Delete your Caramel account | Caramel',
    description:
        'How to delete your Caramel account in the iOS app, in the Android app or by email, what is deleted, and what is kept.',
    heading: 'Delete your Caramel account',
    summary:
        'You can delete your Caramel account in the iOS app or the Android app, or by emailing us from the address on your account. This page says how, what is deleted and what is kept.',
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
        ],
        steps: [
            'Open the Caramel app and sign in if you are not already signed in.',
            'Tap the Account and privacy icon in the top bar.',
            'Tap Delete my account.',
            'Confirm with Delete account.',
        ],
    },
    {
        id: 'extension-and-website',
        heading: 'In the browser extension or on the website',
        paragraphs: [
            'The Caramel browser extension and the grabcaramel.com website have no button that deletes your account. Use one of the apps above, or email us below.',
            'On the website, Profile → Data & privacy can delete your saved Caramel data (savings, favorite stores and coupon results) without deleting your account.',
        ],
    },
    {
        id: 'by-email',
        heading: 'By email',
        paragraphs: [
            'Email hello@devino.ca from the email address on your account and ask us to delete your account. We act on deletion requests within 30 days.',
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
            'The email address, the store address you typed and the browser type on any store request you made. The store request itself stays (see below).',
            'If you signed in with Apple: we ask Apple to revoke the Sign in with Apple tokens for your account.',
        ],
    },
    {
        id: 'what-is-kept',
        heading: 'What is kept',
        paragraphs: ['These are not deleted with your account:'],
        bullets: [
            'Coupon codes you shared stay published while they are valid. They are shown without your name and are no longer linked to you.',
            'The store and status of any store request you made, so the store can still be added. Your email address and browser type are removed from it.',
            'Per-code coupon totals (when a code last worked or failed). They are not tied to you.',
            'A one-way keyed hash of your account (or of your IP address, for a result sent while signed out), kept with each coupon result to stop fake reports. It cannot be turned back into your account or IP address, and it is deleted after 30 days.',
            'Server logs, which can include IP addresses and browser type, for up to 90 days.',
            'Analytics and error records. Our self-hosted analytics (PostHog) and error monitoring (Sentry) can hold events and a profile linked to your account from when you were signed in. Deleting your account does not remove them automatically.',
        ],
    },
]
