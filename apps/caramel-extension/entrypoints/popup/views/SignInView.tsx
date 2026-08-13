import { useState, type FormEvent } from 'react'
import { caramelSetSession } from '../../../caramel-base.js'
import {
    afterLoginSuccess,
    caramelUrl,
    openWebsiteSignIn,
    popupOAuthSupported,
    runSocialSignIn,
} from '../../../popup-core.js'
import type { AppApi } from '../types'

/**
 * The sign-in prompt (P2 React successor to popup.js renderSignInPrompt):
 * social providers, then email/password, then the sign-up and back links.
 *
 * The OAuth WIRE lives in popup-core's runSocialSignIn — every URL, body and
 * message string there is pinned. This view owns only the UI half of that
 * contract: both providers disable together (only one launchWebAuthFlow can be
 * in flight, so the other really is unavailable), the clicked one reads
 * 'Redirecting...', and onError restores both.
 *
 * Email login has no popup-core seam on purpose — it is a plain form POST with
 * no browser-API choreography to extract. Its copy is frozen by
 * popup-email-login: every failure reads "Login failed: <reason>", including
 * the stutter when the server sends no reason at all.
 */
const PROVIDER_LABELS = {
    google: 'Sign in with Google',
    apple: 'Sign in with Apple',
} as const

type Provider = keyof typeof PROVIDER_LABELS

export function SignInView({ api }: { api: AppApi }) {
    const [pending, setPending] = useState<Provider | null>(null)
    const [error, setError] = useState('')
    const [showResend, setShowResend] = useState(false)
    const [revealed, setRevealed] = useState(false)
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')

    // Read at paint AND again at click: the note explains the fallback the
    // buttons will actually take.
    const oauthSupported = popupOAuthSupported()

    const signInWith = (provider: Provider) => {
        if (!popupOAuthSupported()) {
            openWebsiteSignIn()
            return
        }
        void runSocialSignIn(provider, {
            onPending: () => {
                setPending(provider)
                setError('')
            },
            onError: (message: string) => {
                setPending(null)
                setError(message)
            },
        })
    }

    const handleEmailLogin = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        setError('')
        setShowResend(false)

        try {
            const res = await fetch(caramelUrl('api/extension/login'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: email.trim(), password }),
            })

            if (!res.ok) {
                const data = await res.json().catch(() => ({}))
                const reason = data.error || 'Login failed'

                // Three real backend phrasings for the same state; missing one
                // strands the user on an unverified account with no route out.
                const lowered = reason.toLowerCase()
                if (
                    lowered.includes('verify') ||
                    lowered.includes('verification') ||
                    lowered.includes('not verified')
                ) {
                    setShowResend(true)
                }

                throw new Error(reason)
            }

            const { token, username, image } = await res.json()
            caramelSetSession({ token, user: { username, image } }, () =>
                afterLoginSuccess(),
            )
        } catch (err) {
            setError(`Login failed: ${(err as Error).message}`)
        }
    }

    return (
        <div className="login-prompt fade-in-up">
            <div className="oauth-buttons">
                <button
                    type="button"
                    id="googleSignInBtn"
                    className="oauth-button"
                    disabled={pending !== null}
                    onClick={() => signInWith('google')}
                >
                    <svg
                        className="oauth-icon"
                        width="18"
                        height="18"
                        viewBox="0 0 18 18"
                        xmlns="http://www.w3.org/2000/svg"
                    >
                        <path
                            fill="#4285F4"
                            d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"
                        />
                        <path
                            fill="#34A853"
                            d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z"
                        />
                        <path
                            fill="#FBBC05"
                            d="M3.964 10.707c-.18-.54-.282-1.117-.282-1.707s.102-1.167.282-1.707V4.961H.957C.348 6.175 0 7.55 0 9s.348 2.825.957 4.039l3.007-2.332z"
                        />
                        <path
                            fill="#EA4335"
                            d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.961L3.964 7.293C4.672 5.163 6.656 3.58 9 3.58z"
                        />
                    </svg>
                    <span>
                        {pending === 'google'
                            ? 'Redirecting...'
                            : PROVIDER_LABELS.google}
                    </span>
                </button>
                <button
                    type="button"
                    id="appleSignInBtn"
                    className="oauth-button"
                    disabled={pending !== null}
                    onClick={() => signInWith('apple')}
                >
                    <svg
                        className="oauth-icon"
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        xmlns="http://www.w3.org/2000/svg"
                    >
                        <path
                            fill="currentColor"
                            d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"
                        />
                    </svg>
                    <span>
                        {pending === 'apple'
                            ? 'Redirecting...'
                            : PROVIDER_LABELS.apple}
                    </span>
                </button>
            </div>

            {!oauthSupported && (
                <p className="oauth-note">
                    Sign-in opens grabcaramel.com; the extension picks it up
                    automatically.
                </p>
            )}

            <div className="oauth-divider">
                <span>or</span>
            </div>

            <form
                id="loginForm"
                className="login-form"
                onSubmit={handleEmailLogin}
            >
                {error && (
                    <div
                        id="loginErrorMessage"
                        className="error-message"
                        role="alert"
                    >
                        {error}
                    </div>
                )}

                <div>
                    <label htmlFor="email">Email</label>
                    <input
                        type="email"
                        id="email"
                        autoComplete="email"
                        required
                        value={email}
                        onChange={e => setEmail(e.target.value)}
                    />
                </div>

                <div>
                    <label htmlFor="password">Password</label>
                    <div className="password-field">
                        <input
                            type={revealed ? 'text' : 'password'}
                            id="password"
                            autoComplete="current-password"
                            required
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                        />
                        <button
                            type="button"
                            id="togglePasswordBtn"
                            className="password-toggle"
                            aria-label={
                                revealed ? 'Hide password' : 'Show password'
                            }
                            aria-pressed={revealed}
                            onClick={() => setRevealed(current => !current)}
                        >
                            {revealed ? (
                                <svg
                                    id="eyeOffIcon"
                                    width="18"
                                    height="18"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    aria-hidden="true"
                                >
                                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                                    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                                    <path d="m1 1 22 22" />
                                    <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                                </svg>
                            ) : (
                                <svg
                                    id="eyeIcon"
                                    width="18"
                                    height="18"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    aria-hidden="true"
                                >
                                    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
                                    <circle cx="12" cy="12" r="3" />
                                </svg>
                            )}
                        </button>
                    </div>
                </div>

                <button type="submit" className="login-button">
                    Log in
                </button>
            </form>

            {showResend && (
                <div
                    id="resendVerificationContainer"
                    style={{ textAlign: 'center', marginTop: '12px' }}
                >
                    <a
                        href={caramelUrl('verify')}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="resend-verification-btn"
                        style={{
                            display: 'inline-block',
                            textDecoration: 'none',
                        }}
                    >
                        Verify your email
                    </a>
                </div>
            )}

            <p className="mt-6">
                Don&apos;t have an account?{' '}
                <a
                    href={caramelUrl('signup')}
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    Sign Up
                </a>
            </p>

            {/* Vanilla branched Back on whether renderSignInPrompt was handed
                a return view. React reaches this view only as an overlay over
                a resolved one, so there is always somewhere to go back to. */}
            <button
                id="backBtn"
                className="back-btn"
                type="button"
                onClick={api.closeOverlay}
            >
                ← Back
            </button>
        </div>
    )
}
