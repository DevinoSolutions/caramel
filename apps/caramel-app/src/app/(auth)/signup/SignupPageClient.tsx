'use client'

import { signIn, signUp } from '@/lib/auth/client'
import { useFormik } from 'formik'
import { motion } from 'framer-motion'
import dynamic from 'next/dynamic'
import Image from 'next/image'
import Link from 'next/link'
import { useState } from 'react'
import { FaApple, FaGoogle } from 'react-icons/fa'
import { toast } from 'sonner'
import { object, ref, string } from 'yup'

const PasswordChecker = dynamic(
    () => import('@/components/PasswordStrength/PasswordChecker'),
    { ssr: false },
)

const validationSchema = object().shape({
    username: string().min(4).required('Please enter your username'),
    email: string().email().required('Please enter your email'),
    password: string()
        .min(5)
        .matches(/[A-Z]/)
        .matches(/[0-9]/)
        .matches(/[!@#$%^&*+-]/)
        .required(
            'Password must contain at least 5 characters, 1 uppercase, 1 number and 1 special character',
        ),
    confirmPassword: string()
        .oneOf([ref('password')])
        .required("Password doesn't match"),
})

const inputClasses =
    'w-full rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-gray-900 shadow-sm placeholder:text-gray-400 transition duration-200 hover:border-gray-400 focus:border-caramel focus:outline-none focus:ring-2 focus:ring-caramel/30 dark:border-gray-600 dark:bg-darkBg dark:text-gray-100 dark:shadow-none dark:placeholder:text-gray-500 dark:hover:border-gray-500 dark:focus:border-caramel'
const labelClasses =
    'mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300'
const socialButtonClasses =
    'flex w-full items-center justify-center gap-3 rounded-lg border border-caramel/40 bg-white px-4 py-2.5 font-medium text-gray-700 shadow-sm transition duration-200 hover:border-caramel hover:bg-caramel/5 active:bg-caramel/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel/50 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-caramel/50 dark:bg-darkBg dark:text-gray-200 dark:shadow-none dark:hover:bg-caramel/10 dark:active:bg-caramel/15 dark:focus-visible:ring-offset-darkerBg'
const linkClasses =
    'rounded-sm font-semibold text-caramel underline-offset-2 transition hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel/50'

export default function SignupPageClient() {
    const [showPasswordChecker, setShowPasswordChecker] = useState(false)
    const [loading, setLoading] = useState(false)
    const [oauthLoading, setOauthLoading] = useState<string | null>(null)
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
                    setError('Unable to create account')
                    return
                }

                // Redirect to verify page with success message
                window.location.href = '/verify?signup=success'
            } catch {
                toast.error('Something went wrong. Please try again later.')
                setError('Something went wrong')
            } finally {
                setLoading(false)
            }
        },
    })

    const handleSocialSignIn = async (provider: 'google' | 'apple') => {
        setOauthLoading(provider)
        try {
            const result = await signIn.social({
                provider,
                callbackURL: '/',
            })

            if (result?.error) {
                toast.error(
                    `Unable to sign up with ${provider === 'google' ? 'Google' : 'Apple'}. Please try again.`,
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

    const { handleSubmit, errors, touched, handleChange, handleBlur, values } =
        formik

    return (
        <motion.div
            className="w-full min-w-0 max-w-md rounded-2xl border border-gray-200/70 bg-white p-8 shadow-xl shadow-gray-300/40 dark:border-gray-800 dark:bg-darkerBg dark:shadow-black/40 sm:p-6 xs:p-5"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
        >
            <h2 className="mb-6 flex flex-wrap items-center justify-center gap-2 text-center text-2xl font-bold text-caramel">
                <div className="my-auto whitespace-nowrap">Create your</div>
                <Image
                    src="/full-logo.png"
                    alt="logo"
                    height={90}
                    width={90}
                    className="my-auto mt-2"
                />
                <div className="my-auto whitespace-nowrap">account</div>
            </h2>
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
                            : 'Sign up with Google'}
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
                            : 'Sign up with Apple'}
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
                    <label htmlFor="signup-username" className={labelClasses}>
                        Choose a nickname
                    </label>
                    <input
                        id="signup-username"
                        type="text"
                        onBlur={handleBlur}
                        required
                        name={'username'}
                        onChange={handleChange}
                        placeholder="@nickname"
                        className={inputClasses}
                    />
                    <div className="ml-1 mt-1 min-h-[1.25rem]">
                        {errors.username && touched.username && (
                            <div
                                role="alert"
                                className="text-sm text-red-500 dark:text-red-400"
                            >
                                {errors.username}
                            </div>
                        )}
                    </div>
                </div>
                <div>
                    <label htmlFor="signup-email" className={labelClasses}>
                        Email
                    </label>
                    <input
                        id="signup-email"
                        onBlur={handleBlur}
                        type="email"
                        name={'email'}
                        required
                        autoComplete="email"
                        onChange={handleChange}
                        placeholder="Enter your email"
                        className={inputClasses}
                    />
                    <div className="ml-1 mt-1 min-h-[1.25rem]">
                        {errors.email && touched.email && (
                            <div
                                role="alert"
                                className="text-sm text-red-500 dark:text-red-400"
                            >
                                {errors.email}
                            </div>
                        )}
                    </div>
                </div>
                <div>
                    <label htmlFor="signup-password" className={labelClasses}>
                        Password
                    </label>
                    <input
                        id="signup-password"
                        onBlur={handleBlur}
                        /* onFocus, not onClick: a shopper who reaches this
                         * field with Tab, or whose password manager fills it,
                         * never clicks it — and on `onClick` alone they got
                         * their password rejected with the requirements list
                         * still hidden, which is the one thing that would have
                         * told them why. Focus covers clicking too. */
                        onFocus={() => setShowPasswordChecker(true)}
                        type="password"
                        name={'password'}
                        required
                        autoComplete="new-password"
                        onChange={handleChange}
                        placeholder="Create a password"
                        className={`mb-2 ${inputClasses}`}
                    />
                </div>
                <div>
                    <label
                        htmlFor="signup-confirm-password"
                        className={labelClasses}
                    >
                        Re-type Password
                    </label>
                    <input
                        id="signup-confirm-password"
                        onBlur={handleBlur}
                        onFocus={() => setShowPasswordChecker(true)}
                        type="password"
                        name={'confirmPassword'}
                        required
                        autoComplete="new-password"
                        onChange={handleChange}
                        placeholder="Re-type Password"
                        className={inputClasses}
                    />
                </div>
                <div className="col-span-2 flex justify-end">
                    {showPasswordChecker && (
                        <PasswordChecker
                            password={values.password}
                            confirmPassword={values.confirmPassword}
                        />
                    )}
                </div>
                <button
                    disabled={loading || Object.keys(errors).length > 0}
                    type="submit"
                    className="w-full rounded-lg bg-caramel py-2.5 font-semibold text-white shadow-sm transition duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel focus-visible:ring-offset-2 enabled:hover:bg-caramel/90 enabled:hover:shadow-caramel-sm enabled:active:bg-caramel disabled:cursor-not-allowed disabled:opacity-60 dark:focus-visible:ring-offset-darkerBg"
                >
                    {loading ? 'Loading...' : 'Sign Up'}
                </button>
            </form>
            <p className="mt-6 text-center text-sm text-gray-600 dark:text-gray-400">
                Already have an account?{' '}
                <Link href="/login" className={linkClasses}>
                    Login
                </Link>
            </p>
            {error ? (
                <p
                    role="alert"
                    className="mt-4 text-center text-sm text-red-500 dark:text-red-400"
                >
                    {error}
                </p>
            ) : null}
        </motion.div>
    )
}
