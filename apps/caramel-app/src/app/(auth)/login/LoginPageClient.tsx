'use client'

import { signIn } from '@/lib/auth/client'
import { motion } from 'framer-motion'
import Image from 'next/image'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { FormEvent, useEffect, useState } from 'react'
import { FaApple, FaGoogle } from 'react-icons/fa'
import { toast } from 'sonner'

const inputClasses =
    'w-full rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-gray-900 shadow-sm placeholder:text-gray-400 transition duration-200 hover:border-gray-400 focus:border-caramel focus:outline-none focus:ring-2 focus:ring-caramel/30 dark:border-gray-600 dark:bg-darkBg dark:text-gray-100 dark:shadow-none dark:placeholder:text-gray-500 dark:hover:border-gray-500 dark:focus:border-caramel'
const labelClasses =
    'mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300'
const socialButtonClasses =
    'flex w-full items-center justify-center gap-3 rounded-lg border border-caramel/40 bg-white px-4 py-2.5 font-medium text-gray-700 shadow-sm transition duration-200 hover:border-caramel hover:bg-caramel/5 active:bg-caramel/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel/50 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-caramel/50 dark:bg-darkBg dark:text-gray-200 dark:shadow-none dark:hover:bg-caramel/10 dark:active:bg-caramel/15 dark:focus-visible:ring-offset-darkerBg'
const linkClasses =
    'rounded-sm font-semibold text-caramel underline-offset-2 transition hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel/50'

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
    const [oauthLoading, setOauthLoading] = useState<string | null>(null)
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
                    {
                        duration: 5000,
                    },
                )
            } else if (verified === 'true' && !error) {
                toast.success(
                    'Email verified successfully! You can now sign in.',
                    {
                        duration: 5000,
                    },
                )
            }
        }, 100)

        return () => clearTimeout(timer)
    }, [verified, error])

    const handleSubmit = async (event: FormEvent) => {
        event.preventDefault()
        setLoading(true)

        const result = await signIn.email({
            email: email.trim().toLowerCase(),
            password,
        })

        if (result?.error) {
            if (result.error.code === 'EMAIL_NOT_VERIFIED') {
                router.push('/verify')
            } else {
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

    const handleSocialSignIn = async (provider: 'google' | 'apple') => {
        setOauthLoading(provider)
        try {
            const result = await signIn.social({
                provider,
                callbackURL: '/',
            })

            if (result?.error) {
                toast.error(
                    `Unable to sign in with ${provider === 'google' ? 'Google' : 'Apple'}. Please try again.`,
                )
                setOauthLoading(null)
                return
            }

            // signIn.social automatically redirects to OAuth provider
            // The callback will handle redirecting back to callbackURL
        } catch {
            toast.error('Something went wrong. Please try again later.')
            setOauthLoading(null)
        }
    }

    return (
        <motion.div
            className="w-full min-w-0 max-w-md rounded-2xl border border-gray-200/70 bg-white p-8 shadow-xl shadow-gray-300/40 dark:border-gray-800 dark:bg-darkerBg dark:shadow-black/40 sm:p-6 xs:p-5"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
        >
            <h2 className="mb-6 flex flex-wrap items-center justify-center gap-2 text-center text-2xl font-bold text-caramel">
                <div className="my-auto whitespace-nowrap">Sign in to</div>
                <Image
                    src="/full-logo.png"
                    alt="Caramel"
                    height={90}
                    width={90}
                    className="my-auto mt-2"
                />
            </h2>

            {showVerificationAlert && (
                <div
                    role="alert"
                    className="mb-4 rounded-lg border border-orange-300 bg-orange-50 p-4 dark:border-caramel/40 dark:bg-caramel/10"
                >
                    <div className="flex items-start">
                        <div className="flex-1">
                            <p className="text-sm font-medium text-orange-800 dark:text-orange-200">
                                {isTokenExpired
                                    ? 'Verification link expired'
                                    : 'Email verification required'}
                            </p>
                            <p className="mt-1 text-sm text-orange-700 dark:text-orange-300">
                                {isTokenExpired
                                    ? 'Your verification link has expired. Please request a new one to continue.'
                                    : 'Please verify your email address to continue.'}
                            </p>
                        </div>
                    </div>
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

            <div className="mb-4 space-y-3">
                <button
                    type="button"
                    onClick={() => handleSocialSignIn('google')}
                    disabled={!!oauthLoading}
                    className={socialButtonClasses}
                >
                    <FaGoogle className="h-5 w-5 text-caramel" />
                    <span>
                        {oauthLoading === 'google'
                            ? 'Redirecting...'
                            : 'Sign in with Google'}
                    </span>
                </button>
                <button
                    type="button"
                    onClick={() => handleSocialSignIn('apple')}
                    disabled={!!oauthLoading}
                    className={socialButtonClasses}
                >
                    <FaApple className="h-5 w-5 text-caramel" />
                    <span>
                        {oauthLoading === 'apple'
                            ? 'Redirecting...'
                            : 'Sign in with Apple'}
                    </span>
                </button>
            </div>

            <div className="relative my-6">
                <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-gray-200 dark:border-gray-700"></div>
                </div>
                <div className="relative flex justify-center text-sm">
                    <span className="bg-white px-3 text-gray-500 dark:bg-darkerBg dark:text-gray-400">
                        or
                    </span>
                </div>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                    <label htmlFor="login-email" className={labelClasses}>
                        Email
                    </label>
                    <input
                        id="login-email"
                        type="email"
                        required
                        autoComplete="email"
                        placeholder="Enter your email"
                        value={email}
                        onChange={event => setEmail(event.target.value)}
                        className={inputClasses}
                    />
                </div>
                <div>
                    <label htmlFor="login-password" className={labelClasses}>
                        Password
                    </label>
                    <input
                        id="login-password"
                        type="password"
                        required
                        autoComplete="current-password"
                        placeholder="Enter your password"
                        value={password}
                        onChange={event => setPassword(event.target.value)}
                        className={inputClasses}
                    />
                </div>
                <button
                    type="submit"
                    disabled={loading}
                    className="w-full rounded-lg bg-caramel py-2.5 font-semibold text-white shadow-sm transition duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel focus-visible:ring-offset-2 enabled:hover:bg-caramel/90 enabled:hover:shadow-caramel-sm enabled:active:bg-caramel disabled:cursor-not-allowed disabled:opacity-60 dark:focus-visible:ring-offset-darkerBg"
                >
                    {loading ? 'Logging in...' : 'Login'}
                </button>
            </form>
            <p className="mt-6 text-center text-sm text-gray-600 dark:text-gray-400">
                Don&apos;t have an account?{' '}
                <Link className={linkClasses} href="/signup">
                    Sign Up
                </Link>
            </p>
        </motion.div>
    )
}
