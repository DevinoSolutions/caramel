import { expect, type Page, test } from '@playwright/test'

// Better-auth reports a failed sign-in by redirecting with `?error=<code>`.
// Before this spec, production sent those redirects to `/?error=<code>` and
// the homepage ignored the parameter, so a shopper whose Google sign-in or
// verification link failed was dropped on the landing page with no word about
// why (PostHog, Aug-Sep 2026: 34 landings, e.g. `TOKEN_EXPIRED` from a Yahoo
// Mail click, `state_mismatch` from Google).
//
// Nothing here is mocked: each test sends a genuinely bad token or state to
// the REAL better-auth routes and follows the real redirects. None of them
// writes to the database, so they are deployment-safe and run in both e2e
// contexts.

// Filtered by its title: Next's route announcer is a second role=alert on
// every page, so a bare getByRole('alert') is ambiguous.
const noticeWith = (page: Page, title: string) =>
    page.getByRole('alert').filter({ hasText: title })

test.describe('Auth error landing', () => {
    test('a bad verification link from an email explains itself on /login', async ({
        page,
    }) => {
        // Exactly the link shape signup emails carry (callbackURL `/`), with a
        // token better-auth cannot verify.
        await page.goto(
            '/api/auth/verify-email?token=e2e-not-a-real-token&callbackURL=%2F',
        )

        await expect(page).toHaveURL(/\/login\?error=INVALID_TOKEN$/)
        const alert = noticeWith(page, 'Verification link not valid')
        await expect(alert).toBeVisible()
        await alert.getByRole('button', { name: 'Request New Link' }).click()
        await expect(page).toHaveURL(/\/verify$/)
    })

    test('a verification error that lands on / is redirected on the server, code intact', async ({
        page,
    }) => {
        // Links already sitting in inboxes still point at `/`, so the old
        // landing URL has to keep working without JavaScript.
        const res = await page.request.get('/?error=TOKEN_EXPIRED', {
            maxRedirects: 0,
        })
        expect(res.status()).toBe(307)
        expect(res.headers()['location']).toMatch(
            /\/login\?error=TOKEN_EXPIRED$/,
        )

        await page.goto('/?error=TOKEN_EXPIRED')
        await expect(page).toHaveURL(/\/login\?error=TOKEN_EXPIRED$/)
        await expect(
            noticeWith(page, 'Verification link expired'),
        ).toBeVisible()
    })

    test('a Google callback this browser did not start lands on /login with a notice', async ({
        page,
    }) => {
        // What a stale tab, a second window or a replayed callback looks like
        // to the server: a state the browser holds no cookie for.
        await page.goto(
            '/api/auth/callback/google?state=e2e-not-a-real-state&code=e2e-not-a-real-code',
        )

        await expect(page).toHaveURL(/\/login\?error=state_[a-z_]+$/)
        await expect(noticeWith(page, 'Sign-in was interrupted')).toBeVisible()
        // The retry is the Google button right below the notice.
        await expect(
            page.getByRole('button', { name: 'Sign in with Google' }),
        ).toBeVisible()
    })

    test('the homepage without an error is untouched', async ({ page }) => {
        const res = await page.request.get('/', { maxRedirects: 0 })
        expect(res.status()).toBe(200)
    })
})
