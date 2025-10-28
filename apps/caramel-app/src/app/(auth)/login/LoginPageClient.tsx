'use client'

import { ThemeContext } from '@/lib/contexts'
import { motion } from 'framer-motion'
import { signIn } from 'next-auth/react'
import Image from 'next/image'
import Link from 'next/link'
import { FormEvent, useContext, useState } from 'react'
import { toast, ToastContainer } from 'react-toastify'
import 'react-toastify/dist/ReactToastify.css'

export default function LoginPageClient() {
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [loading, setLoading] = useState(false)
    const { isDarkMode } = useContext(ThemeContext)

    const handleSubmit = async (event: FormEvent) => {
        event.preventDefault()
        setLoading(true)
        const result = await signIn('credentials', {
            redirect: false,
            email,
            password,
        })
        if ((result as any)?.error) {
            toast.error((result as any).error || 'Login failed!')
            setLoading(false)
            return
        }
        toast.success('Login successful!')
        window.location.href = '/'
        setLoading(false)
    }

    return (
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
