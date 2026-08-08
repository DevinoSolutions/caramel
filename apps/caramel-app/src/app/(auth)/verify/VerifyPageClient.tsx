'use client'

import AuthCard from '@/components/auth/AuthCard'
import {
    inputClasses,
    labelClasses,
    linkClasses,
    primaryButtonClasses,
} from '@/components/auth/authStyles'
import { authClient } from '@/lib/auth/client'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

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
                    { duration: 6000 },
                )
            } else if (error === 'token_expired') {
                toast.error(
                    'Verification link has expired. Please request a new one.',
                    { duration: 5000 },
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
            const result = await authClient.sendVerificationEmail({
                email: email.trim().toLowerCase(),
                callbackURL: '/login?verified=true',
            })
            // The Better Auth client RETURNS { error } instead of throwing, so
            // the try/catch alone never saw a failure: every call reported
            // "Verification email sent!" including the ones that did not send.
            // That is precisely the failure mode the 2026-08-08 cutover hid on
            // the server side, repeated on the client.
            if (result?.error) {
                toast.error(
                    'Failed to send verification email. Please try again.',
                )
                return
            }
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
        <AuthCard
            title="Verify your email"
            subtitle={
                isNewSignup
                    ? "We've sent a verification link to your inbox. Didn't get it? Enter your email below and we'll send another."
                    : 'Please verify your email address to continue. Enter your email below to receive a new verification link.'
            }
            footer={
                <p className="text-center text-sm text-gray-600 dark:text-gray-400">
                    Already verified?{' '}
                    <Link className={linkClasses} href="/login">
                        Sign in
                    </Link>
                </p>
            }
        >
            <div className="space-y-5">
                <div>
                    <label htmlFor="verify-email" className={labelClasses}>
                        Email
                    </label>
                    <input
                        id="verify-email"
                        type="email"
                        required
                        autoComplete="email"
                        placeholder="you@example.com"
                        value={email}
                        onChange={event => setEmail(event.target.value)}
                        className={inputClasses}
                    />
                </div>
                <button
                    type="button"
                    onClick={handleResendVerification}
                    disabled={resendingEmail}
                    className={primaryButtonClasses}
                >
                    {resendingEmail ? 'Sending…' : 'Send verification email'}
                </button>
            </div>
        </AuthCard>
    )
}
