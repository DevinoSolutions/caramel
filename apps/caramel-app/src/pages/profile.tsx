import AppHeader from '@/components/AppHeader'
import { ThemeContext } from '@/lib/contexts'
import { motion } from 'framer-motion'
import { getSession, signOut } from 'next-auth/react'
import Image from 'next/image'
import { GetServerSideProps } from 'next'
import { useContext } from 'react'
import { toast, ToastContainer } from 'react-toastify'
import 'react-toastify/dist/ReactToastify.css'

interface ProfileProps {
    user: {
        id: string
        username: string
        email: string
        name?: string
        image?: string
    }
}

export default function Profile({ user }: ProfileProps) {
    const { isDarkMode } = useContext(ThemeContext)

    const handleSignOut = async () => {
        try {
            await signOut({ callbackUrl: '/' })
            toast.success('Signed out successfully!')
        } catch (error) {
            toast.error('Error signing out')
        }
    }

    return (
        <>
            <AppHeader
                ogTitle="Caramel | Profile"
                ogDescription="Manage your Caramel account and preferences."
                ogUrl="https://grabcaramel.com/profile"
            />
            <div className="min-h-screen bg-gray-50 py-12">
                <ToastContainer theme={isDarkMode ? 'dark' : 'light'} />
                <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
                    <motion.div
                        className="rounded-lg bg-white p-8 shadow-lg"
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.5 }}
                    >
                        <div className="mb-8 flex items-center gap-6">
                            <div className="h-20 w-20 overflow-hidden rounded-full bg-gray-200">
                                {user.image ? (
                                    <Image
                                        src={user.image}
                                        alt="Profile"
                                        width={80}
                                        height={80}
                                        className="h-full w-full object-cover"
                                    />
                                ) : (
                                    <div className="flex h-full w-full items-center justify-center bg-caramel text-2xl font-bold text-white">
                                        {user.name?.charAt(0) || user.username?.charAt(0) || 'U'}
                                    </div>
                                )}
                            </div>
                            <div>
                                <h1 className="text-3xl font-bold text-gray-900">
                                    {user.name || user.username}
                                </h1>
                                <p className="text-gray-600">{user.email}</p>
                            </div>
                        </div>

                        <div className="space-y-6">
                            <div className="rounded-lg border p-6">
                                <h2 className="mb-4 text-xl font-semibold text-gray-900">
                                    Account Information
                                </h2>
                                <div className="space-y-4">
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700">
                                            Username
                                        </label>
                                        <p className="mt-1 text-gray-900">@{user.username}</p>
                                    </div>
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700">
                                            Email
                                        </label>
                                        <p className="mt-1 text-gray-900">{user.email}</p>
                                    </div>
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700">
                                            Display Name
                                        </label>
                                        <p className="mt-1 text-gray-900">
                                            {user.name || 'Not set'}
                                        </p>
                                    </div>
                                </div>
                            </div>

                            <div className="rounded-lg border p-6">
                                <h2 className="mb-4 text-xl font-semibold text-gray-900">
                                    Account Actions
                                </h2>
                                <div className="space-y-4">
                                    <button
                                        onClick={handleSignOut}
                                        className="bg-red-600 hover:bg-red-700 rounded-md px-4 py-2 font-medium text-white transition"
                                    >
                                        Sign Out
                                    </button>
                                </div>
                            </div>
                        </div>
                    </motion.div>
                </div>
            </div>
        </>
    )
}

export const getServerSideProps: GetServerSideProps = async (context) => {
    const session = await getSession(context)

    if (!session) {
        return {
            redirect: {
                destination: '/login',
                permanent: false,
            },
        }
    }

    return {
        props: {
            user: session.user,
        },
    }
}
