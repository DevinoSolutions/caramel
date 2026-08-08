'use client'

import { authClient } from '@/lib/auth/client'
import { motion } from 'framer-motion'
import Image from 'next/image'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

const inputClasses =
    'w-full rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-gray-900 shadow-sm placeholder:text-gray-400 transition duration-200 hover:border-gray-400 focus:border-caramel focus:outline-none focus:ring-2 focus:ring-caramel/30 dark:border-gray-600 dark:bg-darkBg dark:text-gray-100 dark:shadow-none dark:placeholder:text-gray-500 dark:hover:border-gray-500 dark:focus:border-caramel'

export default function VerifyPageClient({
    signup,
    error,
}: {
    signup?: string
    error?: string
}) {
    const [email, setEmail] = useState('')
    const [resendingEmail, setResendingEmail] = useState(false)
    const isNewSignup = signup === 'success'

    useEffect(() => {
        // Small delay to ensure Toaster is ready
        const timer = setTimeout(() => {
            if (signup === 'success') {
                toast.success(
                    'Account created! Please check your email to verify your account.',
                    {
                        duration: 6000,
                    },
                )
            } else if (error === 'token_expired') {
                toast.error(
                    'Verification link has expired. Please request a new one.',
                    {
                        duration: 5000,
                    },
                )
            }
        }, 100)

        return () => clearTimeout(timer)
    }, [signup, error])

    const handleResendVerification = async () => {
        if (!email) {
            toast.error('Please enter your email address')
            return
        }

        setResendingEmail(true)
        try {
            await authClient.sendVerificationEmail({
                email: email.trim().toLowerCase(),
                callbackURL: '/login?verified=true',
            })
            toast.success(
                'Verification email sent! Please check your inbox and spam folder.',
                { duration: 5000 },
            )
        } catch {
            toast.error('Failed to send verification email. Please try again.')
        } finally {
            setResendingEmail(false)
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
                <div className="my-auto whitespace-nowrap">Verify your</div>
                <Image
                    src="/full-logo.png"
                    alt="logo"
                    height={90}
                    width={90}
                    className="my-auto mt-2"
                />
                <div className="my-auto whitespace-nowrap">account</div>
            </h2>

            <div className="mb-6 text-center text-gray-600 dark:text-gray-300">
                <p>
                    {isNewSignup
                        ? "We've sent a verification email to your inbox."
                        : 'Please verify your email address to continue.'}
                </p>
                <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                    {isNewSignup
                        ? "Didn't receive it? Enter your email below to resend."
                        : 'Enter your email below to receive a new verification link.'}
                </p>
            </div>

            <div className="space-y-4">
                <div>
                    <label
                        htmlFor="verify-email"
                        className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300"
                    >
                        Email
                    </label>
                    <input
                        id="verify-email"
                        type="email"
                        required
                        autoComplete="email"
                        placeholder="Enter your email"
                        value={email}
                        onChange={event => setEmail(event.target.value)}
                        className={inputClasses}
                    />
                </div>
                <button
                    type="button"
                    onClick={handleResendVerification}
                    disabled={resendingEmail}
                    className="w-full rounded-lg bg-caramel py-2.5 font-semibold text-white shadow-sm transition duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel focus-visible:ring-offset-2 enabled:hover:bg-caramel/90 enabled:hover:shadow-caramel-sm enabled:active:bg-caramel disabled:cursor-not-allowed disabled:opacity-60 dark:focus-visible:ring-offset-darkerBg"
                >
                    {resendingEmail ? 'Sending...' : 'Send verification email'}
                </button>
            </div>

            <p className="mt-6 text-center text-sm text-gray-600 dark:text-gray-400">
                Already verified?{' '}
                <Link
                    className="rounded-sm font-semibold text-caramel underline-offset-2 transition hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel/50"
                    href="/login"
                >
                    Sign In
                </Link>
            </p>
        </motion.div>
    )
}
