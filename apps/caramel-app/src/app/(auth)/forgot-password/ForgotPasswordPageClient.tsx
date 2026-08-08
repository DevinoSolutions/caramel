'use client'

import AuthCard from '@/components/auth/AuthCard'
import {
    inputClasses,
    labelClasses,
    linkClasses,
    primaryButtonClasses,
} from '@/components/auth/authStyles'
import { requestPasswordReset } from '@/lib/auth/client'
import Link from 'next/link'
import { FormEvent, useState } from 'react'
import { HiOutlineMail } from 'react-icons/hi'
import { toast } from 'sonner'

export default function ForgotPasswordPageClient() {
    const [email, setEmail] = useState('')
    const [loading, setLoading] = useState(false)
    const [sent, setSent] = useState(false)

    const handleSubmit = async (event: FormEvent) => {
        event.preventDefault()
        setLoading(true)

        const result = await requestPasswordReset({
            email: email.trim().toLowerCase(),
            redirectTo: '/reset-password',
        })

        setLoading(false)

        /* Deliberately the same screen whether or not the address has an
         * account. Branching here would turn this form into an account
         * enumeration oracle: anyone could type addresses and learn which ones
         * are registered. A transport-level failure is still surfaced, because
         * that one is about us, not about who exists. */
        if (result?.error) {
            toast.error('We could not send that email. Please try again.')
            return
        }
        setSent(true)
    }

    if (sent) {
        return (
            <AuthCard
                title="Check your inbox"
                subtitle={
                    <>
                        If an account exists for{' '}
                        <span className="font-medium text-gray-900 dark:text-gray-200">
                            {email.trim().toLowerCase()}
                        </span>
                        , we&apos;ve sent it a link to choose a new password.
                        The link expires in one hour.
                    </>
                }
                footer={
                    <p className="text-center text-sm text-gray-600 dark:text-gray-400">
                        <Link className={linkClasses} href="/login">
                            Back to sign in
                        </Link>
                    </p>
                }
            >
                <div className="flex items-start gap-3 rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600 dark:border-gray-800 dark:bg-darkerBg dark:text-gray-400">
                    <HiOutlineMail
                        aria-hidden="true"
                        className="mt-0.5 h-5 w-5 shrink-0 text-caramel"
                    />
                    <p>
                        Nothing after a few minutes? Check your spam folder, or{' '}
                        <button
                            type="button"
                            onClick={() => setSent(false)}
                            className={linkClasses}
                        >
                            try a different address
                        </button>
                        .
                    </p>
                </div>
            </AuthCard>
        )
    }

    return (
        <AuthCard
            title="Forgot your password?"
            subtitle="Enter the email you signed up with and we'll send you a link to set a new password."
            footer={
                <p className="text-center text-sm text-gray-600 dark:text-gray-400">
                    Remembered it?{' '}
                    <Link className={linkClasses} href="/login">
                        Back to sign in
                    </Link>
                </p>
            }
        >
            <form onSubmit={handleSubmit} className="space-y-5">
                <div>
                    <label htmlFor="forgot-email" className={labelClasses}>
                        Email
                    </label>
                    <input
                        id="forgot-email"
                        type="email"
                        required
                        autoComplete="email"
                        autoFocus
                        placeholder="you@example.com"
                        value={email}
                        onChange={event => setEmail(event.target.value)}
                        className={inputClasses}
                    />
                </div>
                <button
                    type="submit"
                    disabled={loading}
                    className={primaryButtonClasses}
                >
                    {loading ? 'Sending…' : 'Send reset link'}
                </button>
            </form>
        </AuthCard>
    )
}
