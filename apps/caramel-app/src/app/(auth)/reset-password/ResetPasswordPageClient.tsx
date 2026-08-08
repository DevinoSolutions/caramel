'use client'

import AuthCard from '@/components/auth/AuthCard'
import { linkClasses, primaryButtonClasses } from '@/components/auth/authStyles'
import PasswordField from '@/components/auth/PasswordField'
import { resetPassword } from '@/lib/auth/client'
import { firstPasswordFailure } from '@/lib/passwordRules'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { FormEvent, useState } from 'react'
import { toast } from 'sonner'

const PasswordChecker = dynamic(
    () => import('@/components/PasswordStrength/PasswordChecker'),
    { ssr: false },
)

export default function ResetPasswordPageClient({
    token,
    error,
}: {
    token?: string
    error?: string
}) {
    const [password, setPassword] = useState('')
    const [confirmPassword, setConfirmPassword] = useState('')
    const [formError, setFormError] = useState('')
    const [loading, setLoading] = useState(false)
    const [done, setDone] = useState(false)

    /* A missing or rejected token is the common case here, not an edge case:
     * these links expire in an hour and are single-use, so anyone who opens an
     * old email lands in this branch. It gets a real screen with a way
     * forward rather than a form that can only fail on submit. */
    if (!token || error) {
        return (
            <AuthCard
                title="This link has expired"
                subtitle="Password reset links last one hour and can only be used once. Request a fresh one and we'll email it straight over."
                footer={
                    <p className="text-center text-sm text-gray-600 dark:text-gray-400">
                        <Link className={linkClasses} href="/login">
                            Back to sign in
                        </Link>
                    </p>
                }
            >
                <Link
                    href="/forgot-password"
                    className={`${primaryButtonClasses} block text-center`}
                >
                    Request a new link
                </Link>
            </AuthCard>
        )
    }

    if (done) {
        return (
            <AuthCard
                title="Password updated"
                subtitle="Your new password is saved. You can sign in with it now."
            >
                <Link
                    href="/login"
                    className={`${primaryButtonClasses} block text-center`}
                >
                    Continue to sign in
                </Link>
            </AuthCard>
        )
    }

    const handleSubmit = async (event: FormEvent) => {
        event.preventDefault()
        setFormError('')

        const policyFailure = firstPasswordFailure(password)
        if (policyFailure) {
            setFormError(policyFailure)
            return
        }
        if (password !== confirmPassword) {
            setFormError('Both passwords need to match')
            return
        }

        setLoading(true)
        const result = await resetPassword({ newPassword: password, token })
        setLoading(false)

        if (result?.error) {
            setFormError(
                'We could not reset your password with that link. It may have expired — request a new one.',
            )
            toast.error('Unable to reset your password.')
            return
        }
        setDone(true)
    }

    return (
        <AuthCard
            title="Choose a new password"
            subtitle="Pick something you haven't used on Caramel before."
        >
            <form onSubmit={handleSubmit} className="space-y-5" noValidate>
                <PasswordField
                    label="New password"
                    name="password"
                    autoComplete="new-password"
                    placeholder="Create a password"
                    required
                    value={password}
                    onChange={event => setPassword(event.target.value)}
                />
                <PasswordField
                    label="Re-type new password"
                    name="confirmPassword"
                    autoComplete="new-password"
                    placeholder="Re-type your password"
                    required
                    value={confirmPassword}
                    onChange={event => setConfirmPassword(event.target.value)}
                />

                <PasswordChecker
                    password={password}
                    confirmPassword={confirmPassword}
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
                    {loading ? 'Saving…' : 'Save new password'}
                </button>
            </form>
        </AuthCard>
    )
}
