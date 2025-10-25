import AppHeader from '@/components/AppHeader'
import { ThemeContext } from '@/lib/contexts'
import { motion } from 'framer-motion'
import { signIn } from 'next-auth/react'
import Image from 'next/image'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { FormEvent, useContext, useState } from 'react'
import { toast, ToastContainer } from 'react-toastify'
import 'react-toastify/dist/ReactToastify.css'

export default function Login() {
    const router = useRouter()
    const { extension } = router.query // if extension=true, we're logging in for the extension
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [loading, setLoading] = useState(false)
    const { isDarkMode } = useContext(ThemeContext)

    // Determine callback URL based on whether this is for the extension
    // Use full URL to avoid NextAuth URL construction errors
    const getCallbackUrl = () => {
        if (extension === 'true') {
            const baseUrl = typeof window !== 'undefined'
                ? window.location.origin
                : 'https://grabcaramel.com'
            return `${baseUrl}/auth/extension-callback`
        }
        return '/'
    }

    const handleSubmit = async (e: FormEvent) => {
        e.preventDefault()
        setLoading(true)

        const callbackUrl = getCallbackUrl()
        const result = await signIn('credentials', {
            redirect: false,
            email,
            password,
            callbackUrl,
        })

        if (result?.error) {
            toast.error(result.error || 'Login failed!')
            setLoading(false)
            return
        }
        toast.success('Login successful!')

        // For extension login, redirect to callback page
        if (extension === 'true') {
            router.push('/auth/extension-callback')
        } else {
            router.push('/')
        }
        setLoading(false)
    }

    const handleOAuthSignIn = (provider: string) => {
        signIn(provider, { callbackUrl: getCallbackUrl() })
    }


    return (
        <>
            <AppHeader
                ogTitle="Caramel | Login"
                ogDescription="Log in to your Caramel account to access exclusive features and start saving with our coupon extension."
                ogUrl="https://grabcaramel.com/login"
            />
            <div className="flex h-screen items-center justify-center bg-gray-50">
                <ToastContainer theme={isDarkMode ? 'dark' : 'light'} />
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

                    {/* OAuth Buttons */}
                    <div className="mb-6 space-y-3">
                        <button
                            onClick={() => handleOAuthSignIn('google')}
                            className="flex w-full items-center justify-center gap-3 rounded-md border border-gray-300 bg-white px-4 py-2 text-gray-700 transition hover:bg-gray-50"
                        >
                            <Image
                                src="/chrome.png"
                                alt="Google"
                                width={20}
                                height={20}
                            />
                            Continue with Google
                        </button>
                        <button
                            onClick={() => handleOAuthSignIn('apple')}
                            className="flex w-full items-center justify-center gap-3 rounded-md border border-gray-300 bg-black px-4 py-2 text-white transition hover:bg-gray-50 hover:text-black"
                        >
                            <Image
                                src="/apple.png"
                                alt="Apple"
                                width={20}
                                height={20}
                            />
                            Continue with Apple
                        </button>
                    </div>

                    <div className="relative mb-6">
                        <div className="absolute inset-0 flex items-center">
                            <div className="w-full border-t border-gray-300" />
                        </div>
                        <div className="relative flex justify-center text-sm">
                            <span className="bg-white px-2 text-gray-500">Or continue with email</span>
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
                                onChange={e => setEmail(e.target.value)}
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
                                onChange={e => setPassword(e.target.value)}
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


                    <p className="mt-4 text-center text-sm text-gray-600">
                        Don&apos;t have an account?{' '}
                        <Link
                            className="text-caramel font-semibold"
                            href="/signup"
                        >
                            Sign Up
                        </Link>
                    </p>
                </motion.div>
            </div>
        </>
    )
}
