'use client'

import { signIn } from '@/lib/auth/client'
import { motion } from 'framer-motion'
import Image from 'next/image'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { FormEvent, useEffect, useState } from 'react'
import { FaApple, FaGoogle } from 'react-icons/fa'
import { toast } from 'sonner'

export default function LoginPageClient() {
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [loading, setLoading] = useState(false)
    const [oauthLoading, setOauthLoading] = useState<string | null>(null)
    const [showVerificationAlert, setShowVerificationAlert] = useState(false)
    const [isTokenExpired, setIsTokenExpired] = useState(false)
    const router = useRouter()

    useEffect(() => {
        const urlParams = new URLSearchParams(window.location.search)
        const verified = urlParams.get('verified')
        const error = urlParams.get('error')

        // Small delay to ensure Toaster is ready
        const timer = setTimeout(() => {
            if (error === 'token_expired' || error === 'invalid_token') {
                toast.error(
                    'Verification link has expired or is invalid. Please request a new one.',
                    {
                        duration: 5000,
                    },
                )
                setShowVerificationAlert(true)
                setIsTokenExpired(true)
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
    }, [])

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
        <div className="flex h-screen items-center justify-center bg-gray-50">
            <motion.div
                className="w-full max-w-md rounded-lg bg-white p-8 shadow-lg"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5 }}
            >
                <h2 className="mb-6 flex justify-center gap-2 text-center text-2xl font-bold text-caramel">
                    <div className="my-auto">Sign in to</div>
                    <Image
                        src="/full-logo.png"
                        alt="logo"
                        height={90}
                        width={90}
                        className="my-auto mt-2"
                    />
                </h2>

                {showVerificationAlert && (
                    <div className="mb-4 rounded-md border border-orange-300 bg-orange-50 p-4">
                        <div className="flex items-start">
                            <div className="flex-1">
                                <p className="text-sm font-medium text-orange-800">
                                    {isTokenExpired
                                        ? 'Verification link expired'
                                        : 'Email verification required'}
                                </p>
                                <p className="mt-1 text-sm text-orange-700">
                                    {isTokenExpired
                                        ? 'Your verification link has expired. Please request a new one to continue.'
                                        : 'Please verify your email address to continue.'}
                                </p>
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={() => router.push('/verify')}
                            className="mt-3 w-full rounded-md border border-orange-300 bg-white px-4 py-2 text-sm font-semibold text-caramel transition hover:bg-orange-50"
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
                        className="flex w-full items-center justify-center gap-3 rounded-md border border-caramel bg-white px-4 py-2 font-medium text-gray-700 transition hover:border-caramel hover:bg-caramel/10 disabled:cursor-not-allowed disabled:opacity-50"
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
                        className="flex w-full items-center justify-center gap-3 rounded-md border border-caramel bg-white px-4 py-2 font-medium text-gray-700 transition hover:border-caramel hover:bg-caramel/10 disabled:cursor-not-allowed disabled:opacity-50"
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
                        <div className="w-full border-t border-gray-300"></div>
                    </div>
                    <div className="relative flex justify-center text-sm">
                        <span className="bg-white px-2 text-gray-500">or</span>
                    </div>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-black">
                            Email
                        </label>
                        <input
                            type="email"
                            required
                            placeholder="Enter your email"
                            value={email}
                            onChange={event => setEmail(event.target.value)}
                            className="w-full rounded-md border px-4 py-2 focus:outline-none focus:ring-2 focus:ring-caramel"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-black">
                            Password
                        </label>
                        <input
                            type="password"
                            required
                            placeholder="Enter your password"
                            value={password}
                            onChange={event => setPassword(event.target.value)}
                            className="w-full rounded-md border px-4 py-2 focus:outline-none focus:ring-2 focus:ring-caramel"
                        />
                    </div>
                    <button
                        type="submit"
                        disabled={loading}
                        className="w-full rounded-md bg-caramel py-2 font-semibold text-white transition hover:scale-105"
                    >
                        {loading ? 'Logging in...' : 'Login'}
                    </button>
                </form>
                <p className="mt-4 text-center text-sm text-gray-600">
                    Don&apos;t have an account?{' '}
                    <Link className="font-semibold text-caramel" href="/signup">
                        Sign Up
                    </Link>
                </p>
            </motion.div>
        </div>
    )
}
