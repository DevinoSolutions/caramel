'use client'

import AppHeader from '@/components/AppHeader'
import { ThemeContext } from '@/lib/contexts'
import { motion } from 'framer-motion'
import { signOut, useSession } from 'next-auth/react'
import Image from 'next/image'
import Link from 'next/link'
import { useContext, useState } from 'react'
import { toast, ToastContainer } from 'react-toastify'
import 'react-toastify/dist/ReactToastify.css'
import { RiLogoutBoxLine, RiUserLine, RiSettingsLine } from 'react-icons/ri'

export default function Profile() {
    const { data: session, status } = useSession()
    const { isDarkMode } = useContext(ThemeContext)
    const [loading, setLoading] = useState(false)

    const handleSignOut = async () => {
        setLoading(true)
        try {
            await signOut({ redirect: false })
            toast.success('Signed out successfully!')
            window.location.href = '/'
        } catch (error) {
            toast.error('Error signing out')
        } finally {
            setLoading(false)
        }
    }

    if (status === 'loading') {
        return (
            <div className="flex h-screen items-center justify-center">
                <div className="text-center">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-caramel mx-auto"></div>
                    <p className="mt-4 text-gray-600">Loading...</p>
                </div>
            </div>
        )
    }

    if (status === 'unauthenticated') {
        return (
            <div className="flex h-screen items-center justify-center">
                <div className="text-center">
                    <h1 className="text-2xl font-bold text-gray-800 mb-4">Access Denied</h1>
                    <p className="text-gray-600 mb-6">You need to be logged in to view this page.</p>
                    <Link
                        href="/login"
                        className="bg-caramel text-white px-6 py-2 rounded-md hover:bg-opacity-90 transition"
                    >
                        Sign In
                    </Link>
                </div>
            </div>
        )
    }

    return (
        <>
            <AppHeader
                ogTitle="Caramel | Profile"
                ogDescription="Manage your Caramel account and preferences."
                ogUrl="https://grabcaramel.com/profile"
            />
            <div className="min-h-screen bg-gray-50 py-8">
                <ToastContainer theme={isDarkMode ? 'dark' : 'light'} />
                <div className="max-w-4xl mx-auto px-4">
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.5 }}
                        className="bg-white rounded-lg shadow-lg overflow-hidden"
                    >
                        {/* Profile Header */}
                        <div className="bg-gradient-to-r from-caramel to-orange-500 px-8 py-12">
                            <div className="flex items-center space-x-6">
                                <div className="relative">
                                    {session?.user?.image ? (
                                        <Image
                                            src={session.user.image}
                                            alt="Profile"
                                            width={80}
                                            height={80}
                                            className="rounded-full border-4 border-white"
                                        />
                                    ) : (
                                        <div className="w-20 h-20 bg-white rounded-full flex items-center justify-center">
                                            <RiUserLine className="text-4xl text-caramel" />
                                        </div>
                                    )}
                                </div>
                                <div>
                                    <h1 className="text-3xl font-bold text-white">
                                        {session?.user?.name || 'User'}
                                    </h1>
                                    <p className="text-orange-100 text-lg">
                                        {session?.user?.email}
                                    </p>
                                    <p className="text-orange-200 text-sm">
                                        @{session?.user?.username || 'username'}
                                    </p>
                                </div>
                            </div>
                        </div>

                        {/* Profile Content */}
                        <div className="p-8">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                                {/* Account Information */}
                                <div className="space-y-6">
                                    <h2 className="text-2xl font-semibold text-gray-800 flex items-center">
                                        <RiUserLine className="mr-2 text-caramel" />
                                        Account Information
                                    </h2>
                                    
                                    <div className="space-y-4">
                                        <div>
                                            <label className="block text-sm font-medium text-gray-700">
                                                Full Name
                                            </label>
                                            <p className="mt-1 text-lg text-gray-900">
                                                {session?.user?.name || 'Not provided'}
                                            </p>
                                        </div>
                                        
                                        <div>
                                            <label className="block text-sm font-medium text-gray-700">
                                                Email Address
                                            </label>
                                            <p className="mt-1 text-lg text-gray-900">
                                                {session?.user?.email}
                                            </p>
                                        </div>
                                        
                                        <div>
                                            <label className="block text-sm font-medium text-gray-700">
                                                Username
                                            </label>
                                            <p className="mt-1 text-lg text-gray-900">
                                                @{session?.user?.username || 'Not set'}
                                            </p>
                                        </div>
                                    </div>
                                </div>

                                {/* Quick Actions */}
                                <div className="space-y-6">
                                    <h2 className="text-2xl font-semibold text-gray-800 flex items-center">
                                        <RiSettingsLine className="mr-2 text-caramel" />
                                        Quick Actions
                                    </h2>
                                    
                                    <div className="space-y-4">
                                        <Link
                                            href="/supported-sites"
                                            className="block w-full bg-gray-100 hover:bg-gray-200 text-gray-800 font-medium py-3 px-4 rounded-lg transition"
                                        >
                                            View Supported Sites
                                        </Link>
                                        
                                        <Link
                                            href="/privacy"
                                            className="block w-full bg-gray-100 hover:bg-gray-200 text-gray-800 font-medium py-3 px-4 rounded-lg transition"
                                        >
                                            Privacy Policy
                                        </Link>
                                        
                                        <button
                                            onClick={handleSignOut}
                                            disabled={loading}
                                            className="w-full bg-red-100 hover:bg-red-200 text-red-800 font-medium py-3 px-4 rounded-lg transition flex items-center justify-center"
                                        >
                                            <RiLogoutBoxLine className="mr-2" />
                                            {loading ? 'Signing out...' : 'Sign Out'}
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {/* Extension Status */}
                            <div className="mt-8 pt-8 border-t border-gray-200">
                                <h3 className="text-xl font-semibold text-gray-800 mb-4">
                                    Extension Status
                                </h3>
                                <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                                    <div className="flex items-center">
                                        <div className="w-3 h-3 bg-green-400 rounded-full mr-3"></div>
                                        <span className="text-green-800 font-medium">
                                            Caramel Extension is active and ready to help you save!
                                        </span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </motion.div>
                </div>
            </div>
        </>
    )
}
