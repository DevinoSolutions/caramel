import { describeAuthError } from '@/lib/auth/authErrors'
import { describe, expect, it } from 'vitest'

// The codes better-auth 1.6 actually redirects with. Before describeAuthError
// every one of these reached the shopper as a bare `?error=` nobody read; the
// real-server path (redirect → /login → visible notice) is pinned end to end
// in e2e/auth-error-landing.spec.ts.
describe('describeAuthError', () => {
    it('no code means no notice', () => {
        expect(describeAuthError(undefined)).toBeNull()
        expect(describeAuthError('')).toBeNull()
        expect(describeAuthError('   ')).toBeNull()
    })

    it('matches the email-verification route’s UPPER_CASE codes as well as snake_case', () => {
        // verify-email redirects with BASE_ERROR_CODES (TOKEN_EXPIRED); the
        // old checks compared against 'token_expired' and so never fired.
        expect(describeAuthError('TOKEN_EXPIRED')).toEqual(
            describeAuthError('token_expired'),
        )
        expect(describeAuthError('TOKEN_EXPIRED')?.title).toBe(
            'Verification link expired',
        )
        expect(describeAuthError('INVALID_TOKEN')?.title).toBe(
            'Verification link not valid',
        )
    })

    it('verification-link failures point at the resend page', () => {
        for (const code of ['TOKEN_EXPIRED', 'INVALID_TOKEN']) {
            expect(describeAuthError(code)?.action).toEqual({
                label: 'Request New Link',
                href: '/verify',
            })
        }
    })

    it('an unverified password account blocking Google/Apple sends the shopper to verify it', () => {
        const notice = describeAuthError('account_not_linked')
        expect(notice?.title).toBe('Verify your email first')
        expect(notice?.action?.href).toBe('/verify')
    })

    it('a lost or forged OAuth state reads as an interrupted sign-in, with the retry buttons as the next step', () => {
        for (const code of [
            'state_mismatch',
            'state_not_found',
            'state_invalid',
            'state_security_mismatch',
            'please_restart_the_process',
        ]) {
            const notice = describeAuthError(code)
            expect(notice?.title).toBe('Sign-in was interrupted')
            expect(notice?.action).toBeNull()
        }
    })

    it('a repeated `error` param (Next hands over string[]) uses the first value instead of throwing', () => {
        expect(describeAuthError(['TOKEN_EXPIRED', 'state_mismatch'])).toBe(
            describeAuthError('TOKEN_EXPIRED'),
        )
        expect(describeAuthError([])).toBeNull()
    })

    it('any other code still gets a notice rather than silence', () => {
        for (const code of [
            'invalid_code',
            'internal_server_error',
            'UNKNOWN',
            'some_code_better_auth_adds_later',
        ]) {
            expect(describeAuthError(code)?.title).toBe(
                'Sign-in did not complete',
            )
        }
    })
})
