'use client'

import AuthCard, { AuthDivider } from '@/components/auth/AuthCard'
import {
    inputClasses,
    labelClasses,
    linkClasses,
    primaryButtonClasses,
} from '@/components/auth/authStyles'
import PasswordField from '@/components/auth/PasswordField'
import SocialSignIn from '@/components/auth/SocialSignIn'
import { signIn } from '@/lib/auth/client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { FormEvent, useEffect, useState } from 'react'
import { toast } from 'sonner'

export default function LoginPageClient({
    verified,
    error,
}: {
    verified?: string
    error?: string
}) {
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [loading, setLoading] = useState(false)
    const [formError, setFormError] = useState('')
    const router = useRouter()

    /* Derived, not state: the alert is a function of the URL, and as state it
     * could only ever appear one hydration + 100ms after the page did.
     *
     * These two are deliberately the same expression, which preserves exactly
     * what the effect used to do — it set both flags in the one branch. The
     * consequence is that the alert's other wording ("Email verification
     * required" / "Verify Email Now") is currently unreachable, and that
     * `?error=invalid_token` tells the shopper their link EXPIRED when it was
     * rejected as invalid. TODO: decide which copy each error deserves; this
     * change deliberately does not alter product copy while fixing a race.
     */
    const showVerificationAlert =
        error === 'token_expired' || error === 'invalid_token'
    const isTokenExpired = showVerificationAlert

    useEffect(() => {
        // Toasts are client-only by nature, and the small delay is here to let
        // the Toaster mount. Only the toast needs to wait now.
        const timer = setTimeout(() => {
            if (error === 'token_expired' || error === 'invalid_token') {
                toast.error(
                    'Verification link has expired or is invalid. Please request a new one.',
                    { duration: 5000 },
                )
            } else if (verified === 'true' && !error) {
                toast.success(
                    'Email verified successfully! You can now sign in.',
                    { duration: 5000 },
                )
            }
        }, 100)

        return () => clearTimeout(timer)
    }, [verified, error])

    const handleSubmit = async (event: FormEvent) => {
        event.preventDefault()
        setLoading(true)
        setFormError('')

        const result = await signIn.email({
            email: email.trim().toLowerCase(),
            password,
        })

        if (result?.error) {
            if (result.error.code === 'EMAIL_NOT_VERIFIED') {
                router.push('/verify')
            } else {
                // Shown in the form as well as the toast: a toast that has
                // already auto-dismissed leaves a shopper staring at a form
                // with no indication of what went wrong.
                setFormError(
                    'That email and password combination did not work. Check them and try again.',
                )
                toast.error(
                    'Unable to sign in. Please check your email and password.',
                )
            }
            setLoading(false)
            return
        }
        toast.success('Welcome back!')
        window.location.href = '/'
        setLoading(false)
    }

    return (
        <AuthCard
            title="Welcome back"
            subtitle="Sign in to sync your savings across every browser you use Caramel in."
            footer={
                <p className="text-center text-sm text-gray-600 dark:text-gray-400">
                    Don&apos;t have an account?{' '}
                    <Link className={linkClasses} href="/signup">
                        Create one free
                    </Link>
                </p>
            }
        >
            {showVerificationAlert && (
                <div
                    role="alert"
                    className="mb-6 rounded-xl border border-orange-300 bg-orange-50 p-4 dark:border-caramel/40 dark:bg-caramel/10"
                >
                    <p className="text-sm font-semibold text-orange-800 dark:text-orange-200">
                        {isTokenExpired
                            ? 'Verification link expired'
                            : 'Email verification required'}
                    </p>
                    <p className="mt-1 text-sm text-orange-700 dark:text-orange-300">
                        {isTokenExpired
                            ? 'Your verification link has expired. Please request a new one to continue.'
                            : 'Please verify your email address to continue.'}
                    </p>
                    <button
                        type="button"
                        onClick={() => router.push('/verify')}
                        className="mt-3 w-full rounded-lg border border-orange-300 bg-white px-4 py-2 text-sm font-semibold text-caramel shadow-sm transition duration-200 hover:bg-orange-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel/50 focus-visible:ring-offset-2 dark:border-caramel/40 dark:bg-darkBg dark:shadow-none dark:hover:bg-caramel/10 dark:focus-visible:ring-offset-darkerBg"
                    >
                        {isTokenExpired
                            ? 'Request New Link'
                            : 'Verify Email Now'}
                    </button>
                </div>
            )}

            <SocialSignIn verb="Sign in" />
            <AuthDivider />

            {/* No noValidate here, unlike signup: this form has no client-side
                validation of its own, so the browser's own required-field
                blocking is the only thing stopping an empty submit from firing
                a pointless sign-in request. */}
            <form onSubmit={handleSubmit} className="space-y-5">
                <div>
                    <label htmlFor="login-email" className={labelClasses}>
                        Email
                    </label>
                    <input
                        id="login-email"
                        type="email"
                        required
                        autoComplete="email"
                        placeholder="you@example.com"
                        value={email}
                        onChange={event => setEmail(event.target.value)}
                        className={inputClasses}
                    />
                </div>

                <PasswordField
                    label="Password"
                    name="password"
                    autoComplete="current-password"
                    placeholder="Enter your password"
                    required
                    value={password}
                    onChange={event => setPassword(event.target.value)}
                    trailingLabel={
                        <Link
                            href="/forgot-password"
                            className="text-sm font-medium text-caramel underline-offset-2 transition hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel/50"
                        >
                            Forgot password?
                        </Link>
                    }
                />

                {formError ? (
                    <p
                        role="alert"
                        className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300"
                    >
                        {formError}
                    </p>
                ) : null}

                <button
                    type="submit"
                    disabled={loading}
                    className={primaryButtonClasses}
                >
                    {loading ? 'Signing in…' : 'Sign in'}
                </button>
            </form>
        </AuthCard>
    )
}
