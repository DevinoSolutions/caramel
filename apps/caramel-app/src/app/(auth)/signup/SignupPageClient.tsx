'use client'

import AuthCard, { AuthDivider } from '@/components/auth/AuthCard'
import {
    fieldErrorClasses,
    inputClasses,
    labelClasses,
    linkClasses,
    primaryButtonClasses,
} from '@/components/auth/authStyles'
import PasswordField from '@/components/auth/PasswordField'
import SocialSignIn from '@/components/auth/SocialSignIn'
import { signUp } from '@/lib/auth/client'
import { firstPasswordFailure } from '@/lib/passwordRules'
import { useFormik } from 'formik'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useState } from 'react'
import { toast } from 'sonner'
import { object, ref, string } from 'yup'

const PasswordChecker = dynamic(
    () => import('@/components/PasswordStrength/PasswordChecker'),
    { ssr: false },
)

/* The password branch is built from `@/lib/passwordRules`, the same source the
 * on-screen checklist renders, so the two cannot disagree about what a valid
 * password is.
 *
 * Every rule also carries an explicit message. Without one, yup falls back to
 * printing the constraint itself, so a shopper who typed a lowercase-only
 * password was previously shown the literal regex
 * ("password must match the following: /[A-Z]/"). */
const validationSchema = object().shape({
    username: string()
        .min(4, 'Nicknames need at least 4 characters')
        .required('Please choose a nickname'),
    email: string()
        .email('That does not look like an email address')
        .required('Please enter your email'),
    password: string()
        .required('Please create a password')
        .test(
            'password-policy',
            'Password does not meet the requirements',
            function (value) {
                const failure = firstPasswordFailure(value ?? '')
                return failure ? this.createError({ message: failure }) : true
            },
        ),
    confirmPassword: string()
        .oneOf([ref('password')], 'Both passwords need to match')
        .required('Please re-type your password'),
})

export default function SignupPageClient() {
    const [showPasswordChecker, setShowPasswordChecker] = useState(false)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState('')

    const formik = useFormik({
        initialValues: {
            username: '',
            email: '',
            password: '',
            confirmPassword: '',
        },
        validationSchema,
        onSubmit: async ({ username, email, password }) => {
            setLoading(true)
            setError('')
            try {
                const result = await signUp.email({
                    name: username.trim().toLowerCase(),
                    email: email.trim().toLowerCase(),
                    password,
                    username: username.trim().toLowerCase(),
                })

                if (result?.error) {
                    toast.error(
                        'Unable to create your account. Please try again or use a different email.',
                    )
                    setError(
                        'We could not create that account. Try a different email, or sign in if you already have one.',
                    )
                    return
                }

                // Redirect to verify page with success message
                window.location.href = '/verify?signup=success'
            } catch {
                toast.error('Something went wrong. Please try again later.')
                setError('Something went wrong. Please try again later.')
            } finally {
                setLoading(false)
            }
        },
    })

    const { handleSubmit, errors, touched, handleChange, handleBlur, values } =
        formik

    const fieldError = (name: keyof typeof values) =>
        touched[name] && errors[name] ? errors[name] : undefined

    return (
        <AuthCard
            title="Create your account"
            subtitle="Free forever. Caramel finds and applies coupon codes for you at checkout."
            footer={
                <p className="text-center text-sm text-gray-600 dark:text-gray-400">
                    Already have an account?{' '}
                    <Link href="/login" className={linkClasses}>
                        Sign in
                    </Link>
                </p>
            }
        >
            <SocialSignIn verb="Sign up" />
            <AuthDivider />

            <form onSubmit={handleSubmit} className="space-y-5" noValidate>
                <div>
                    <label htmlFor="signup-username" className={labelClasses}>
                        Nickname
                    </label>
                    <input
                        id="signup-username"
                        type="text"
                        name="username"
                        required
                        autoComplete="nickname"
                        placeholder="@nickname"
                        value={values.username}
                        onBlur={handleBlur}
                        onChange={handleChange}
                        aria-invalid={fieldError('username') ? true : undefined}
                        className={inputClasses}
                    />
                    {fieldError('username') ? (
                        <p role="alert" className={fieldErrorClasses}>
                            {errors.username}
                        </p>
                    ) : null}
                </div>

                <div>
                    <label htmlFor="signup-email" className={labelClasses}>
                        Email
                    </label>
                    <input
                        id="signup-email"
                        type="email"
                        name="email"
                        required
                        autoComplete="email"
                        placeholder="you@example.com"
                        value={values.email}
                        onBlur={handleBlur}
                        onChange={handleChange}
                        aria-invalid={fieldError('email') ? true : undefined}
                        className={inputClasses}
                    />
                    {fieldError('email') ? (
                        <p role="alert" className={fieldErrorClasses}>
                            {errors.email}
                        </p>
                    ) : null}
                </div>

                <PasswordField
                    label="Password"
                    name="password"
                    autoComplete="new-password"
                    placeholder="Create a password"
                    required
                    value={values.password}
                    onChange={handleChange}
                    onBlur={handleBlur}
                    /* onFocus, not onClick: a shopper who reaches this field
                     * with Tab, or whose password manager fills it, never
                     * clicks it — and on `onClick` alone they got their
                     * password rejected with the requirements list still
                     * hidden, which is the one thing that would have told them
                     * why. Focus covers clicking too. */
                    onFocus={() => setShowPasswordChecker(true)}
                    error={fieldError('password')}
                />

                <PasswordField
                    label="Re-type password"
                    name="confirmPassword"
                    autoComplete="new-password"
                    placeholder="Re-type your password"
                    required
                    value={values.confirmPassword}
                    onChange={handleChange}
                    onBlur={handleBlur}
                    onFocus={() => setShowPasswordChecker(true)}
                    error={fieldError('confirmPassword')}
                />

                {showPasswordChecker && (
                    <div className="flex justify-end">
                        <PasswordChecker
                            password={values.password}
                            confirmPassword={values.confirmPassword}
                        />
                    </div>
                )}

                <button
                    disabled={loading}
                    type="submit"
                    className={primaryButtonClasses}
                >
                    {loading ? 'Creating your account…' : 'Create account'}
                </button>

                {error ? (
                    <p
                        role="alert"
                        className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300"
                    >
                        {error}
                    </p>
                ) : null}
            </form>
        </AuthCard>
    )
}
