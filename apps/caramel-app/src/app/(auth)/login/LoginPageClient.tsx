'use client'

import { signIn } from '@/lib/auth/client'
import { motion } from 'framer-motion'
import Image from 'next/image'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { FormEvent, useEffect, useState } from 'react'
import { toast } from 'sonner'

export default function LoginPageClient() {
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [loading, setLoading] = useState(false)
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

    // Add OAuth button handlers
    const handleGoogleSignIn = async () => {
        await signIn.social({ provider: 'google' })
    }

    const handleAppleSignIn = async () => {
        await signIn.social({ provider: 'apple' })
    }

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

    return (
        <div className="flex h-screen items-center justify-center bg-gray-50">
            <motion.div
                className="w-full max-w-md rounded-lg bg-white p-8 shadow-lg"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5 }}
            >
                <h2 className="text-caramel mb-6 flex justify-center gap-2 text-center text-2xl font-bold">
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
                            className="text-caramel mt-3 w-full rounded-md border border-orange-300 bg-white px-4 py-2 text-sm font-semibold transition hover:bg-orange-50"
                        >
                            {isTokenExpired
                                ? 'Request New Link'
                                : 'Verify Email Now'}
                        </button>
                    </div>
                )}

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
                            className="focus:ring-caramel w-full rounded-md border px-4 py-2 focus:outline-none focus:ring-2"
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
                            className="focus:ring-caramel w-full rounded-md border px-4 py-2 focus:outline-none focus:ring-2"
                        />
                    </div>
                    <button
                        type="submit"
                        disabled={loading}
                        className="bg-caramel w-full rounded-md py-2 font-semibold text-white transition hover:scale-105"
                    >
                        {loading ? 'Logging in...' : 'Login'}
                    </button>
                </form>

                
                <div className="relative my-4">
                    <div className="absolute inset-0 flex items-center">
                        <div className="w-full border-t border-gray-300"></div>
                    </div>
                    <div className="relative flex justify-center text-sm">
                        <span className="bg-white px-2 text-gray-500">Or continue with</span>
                    </div>
                </div>

                <div className="flex flex-col gap-3">
                    {/* Google Sign In */}
                    <button
                        type="button"
                        onClick={handleGoogleSignIn}
                        className="w-full flex items-center justify-center gap-3 rounded-lg border border-gray-300 bg-white py-2.5 px-4 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 transition-colors"
                    >
                        <Image
                        src="google.png"
                        width={24}
                        height={24}
                        alt="Google"
                        className="object-contain"
                        unoptimized
                        />
                        Sign in with Google
                    </button>

                    {/* Apple Sign In */}
                    <button
                        type="button"
                        onClick={handleAppleSignIn}
                        className="w-full flex items-center justify-center gap-3 rounded-lg border border-gray-300 bg-black py-2.5 px-4 text-sm font-medium text-white shadow-sm hover:bg-gray-900 transition-colors"
                    >
                        <Image
                        src="apple-white.png"
                        width={24}
                        height={24}
                        alt="Apple"
                        className="object-contain"
                        unoptimized
                        />
                        Sign in with Apple
                    </button>
                </div>

                <p className="mt-4 text-center text-sm text-gray-600">
                    Don&apos;t have an account?{' '}
                    <Link className="text-caramel font-semibold" href="/signup">
                        Sign Up
                    </Link>
                </p>
            </motion.div>
        </div>
    )
}
