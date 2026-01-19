'use client'

import { signOut, useSession } from '@/lib/auth/client'
import { motion } from 'framer-motion'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { FormEvent, useEffect, useState } from 'react'
import { toast } from 'sonner'

export default function ProfilePageClient() {
    const { data: session, isPending } = useSession()
    const router = useRouter()
    const [isEditing, setIsEditing] = useState(false)
    const [loading, setLoading] = useState(false)
    const [formData, setFormData] = useState({
        name: '',
        username: '',
        email: '',
    })

    useEffect(() => {
        if (!isPending && !session) {
            router.push('/login')
        } else if (session?.user) {
            setFormData({
                name: session.user.name || '',
                username: session.user.username || '',
                email: session.user.email || '',
            })
        }
    }, [session, isPending, router])

    const handleSignOut = async () => {
        await signOut()
        toast.success('Signed out successfully')
        window.location.href = '/'
    }

    const handleSubmit = async (event: FormEvent) => {
        event.preventDefault()
        setLoading(true)

        try {
            const response = await fetch('/api/user/profile', {
                 method: 'PATCH',
                 headers: { 'Content-Type': 'application/json' },
                 body: JSON.stringify(formData),
            })

            if (!response.ok) throw new Error('Failed to update profile')

            toast.success('Profile updated successfully!')
            setIsEditing(false)
        } catch (error) {
            toast.error('Failed to update profile. Please try again.')
        } finally {
            setLoading(false)
        }
    }

    const handleCancel = () => {
        setIsEditing(false)
        if (session?.user) {
            setFormData({
                name: session.user.name || '',
                username: session.user.username || '',
                email: session.user.email || '',
            })
        }
    }

    if (isPending) {
        return (
            <div className="flex h-screen items-center justify-center bg-gray-50">
                <div className="text-caramel text-lg font-medium">
                    Loading...
                </div>
            </div>
        )
    }

    if (!session?.user) {
        return null
    }

    const userInitial =
        session.user.name?.charAt(0).toUpperCase() ||
        session.user.email?.charAt(0).toUpperCase() ||
        'U'

    const userImage = session?.user?.image || session?.user?.encodedPictureUrl

    const memberSince = session.user.createdAt
        ? new Date(session.user.createdAt).toLocaleDateString('en-US', {
              month: 'long',
              year: 'numeric',
          })
        : 'Recently'

    return (
        <div className="min-h-screen bg-gray-50 py-12">
            <div className="mx-auto max-w-4xl px-4">
                {/* Header Card */}
                <motion.div
                    className="mb-6 overflow-hidden rounded-lg bg-white shadow-lg"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5 }}
                >
                    <div className="bg-gradient-to-r from-caramel to-orange-400 h-32"></div>
                    <div className="relative px-8 pb-8">
                        <div className="bg-caramel -mt-16 mb-4 flex h-32 w-32 items-center justify-center overflow-hidden rounded-full border-4 border-white text-5xl font-bold text-white shadow-lg">
                            {userImage ? (
                                <Image
                                    src={userImage}
                                    alt="Profile"
                                    width={128}
                                    height={128}
                                    className="h-full w-full object-cover"
                                />
                            ) : (
                                userInitial
                            )}
                        </div>
                        <div className="flex items-start justify-between">
                            <div>
                                <h1 className="text-3xl font-bold text-gray-900">
                                    {session.user.name || 'Caramel User'}
                                </h1>
                                <p className="text-caramel mt-1 text-sm font-medium">
                                    @{session.user.username || 'user'}
                                </p>
                                <p className="mt-2 text-sm text-gray-500">
                                    Member since {memberSince}
                                </p>
                            </div>
                            <button
                                onClick={handleSignOut}
                                className="rounded-lg border-2 border-gray-300 px-6 py-2 text-sm font-medium text-gray-700 transition hover:border-red-500 hover:text-red-500"
                            >
                                Sign Out
                            </button>
                        </div>
                    </div>
                </motion.div>

                {/* Account Information Card */}
                <motion.div
                    className="rounded-lg bg-white p-8 shadow-lg"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, delay: 0.1 }}
                >
                    <div className="mb-6 flex items-center justify-between">
                        <h2 className="text-2xl font-bold text-gray-900">
                            Account Information
                        </h2>
                        {!isEditing && (
                            <button
                                onClick={() => setIsEditing(true)}
                                className="bg-caramel rounded-lg px-6 py-2 text-sm font-semibold text-white transition hover:scale-105"
                            >
                                Edit Profile
                            </button>
                        )}
                    </div>

                    <form onSubmit={handleSubmit} className="space-y-6">
                        {/* Full Name */}
                        <div>
                            <label className="mb-2 block text-sm font-medium text-gray-700">
                                Full Name
                            </label>
                            {isEditing ? (
                                <input
                                    type="text"
                                    value={formData.name}
                                    onChange={e =>
                                        setFormData({
                                            ...formData,
                                            name: e.target.value,
                                        })
                                    }
                                    className="focus:ring-caramel w-full rounded-md border border-gray-300 px-4 py-2 focus:outline-none focus:ring-2"
                                    placeholder="Enter your full name"
                                />
                            ) : (
                                <div className="rounded-md bg-gray-50 px-4 py-2 text-gray-900">
                                    {formData.name || 'Not set'}
                                </div>
                            )}
                        </div>

                        {/* Username */}
                        <div>
                            <label className="mb-2 block text-sm font-medium text-gray-700">
                                Username
                            </label>
                            {isEditing ? (
                                <input
                                    type="text"
                                    value={formData.username}
                                    onChange={e =>
                                        setFormData({
                                            ...formData,
                                            username: e.target.value,
                                        })
                                    }
                                    className="focus:ring-caramel w-full rounded-md border border-gray-300 px-4 py-2 focus:outline-none focus:ring-2"
                                    placeholder="@username"
                                />
                            ) : (
                                <div className="rounded-md bg-gray-50 px-4 py-2 text-gray-900">
                                    @{formData.username || 'Not set'}
                                </div>
                            )}
                        </div>

                        {/* Email */}
                        <div>
                            <label className="mb-2 block text-sm font-medium text-gray-700">
                                Email Address
                            </label>
                            <div className="flex items-center gap-2 rounded-md bg-gray-50 px-4 py-2 text-gray-900">
                                {formData.email}
                                {session.user.emailVerified && (
                                    <span className="bg-caramel rounded-full px-2 py-0.5 text-xs font-medium text-white">
                                        Verified
                                    </span>
                                )}
                            </div>
                        
                        </div>

                        {/* Account Status */}
                        <div>
                            <label className="mb-2 block text-sm font-medium text-gray-700">
                                Account Status
                            </label>
                            <div className="rounded-md bg-gray-50 px-4 py-2">
                                <span className="inline-flex items-center gap-2 text-gray-900">
                                    <span
                                        className={`h-2 w-2 rounded-full ${
                                            session.user.status === 'ACTIVE_USER'
                                                ? 'bg-green-500'
                                                : session.user.status === 'USER_BANNED'
                                                  ? 'bg-red-500'
                                                  : session.user.status === 'DELETE_REQUESTED_BY_USER'
                                                    ? 'bg-orange-500'
                                                    : 'bg-yellow-500'
                                        }`}
                                    ></span>
                                    {session.user.status === 'ACTIVE_USER'
                                        ? 'Active'
                                        : session.user.status === 'NOT_VERIFIED'
                                          ? 'Not Verified'
                                          : session.user.status === 'USER_BANNED'
                                            ? 'Banned'
                                            : session.user.status === 'DELETE_REQUESTED_BY_USER'
                                              ? 'Deletion Pending'
                                              : 'Unknown'}
                                </span>
                            </div>
                        </div>

                        {/* Action Buttons */}
                        {isEditing && (
                            <div className="flex gap-4 pt-4">
                                <button
                                    type="submit"
                                    disabled={loading}
                                    className="bg-caramel flex-1 rounded-lg py-3 font-semibold text-white transition hover:scale-105 disabled:opacity-50"
                                >
                                    {loading ? 'Saving...' : 'Save Changes'}
                                </button>
                                <button
                                    type="button"
                                    onClick={handleCancel}
                                    disabled={loading}
                                    className="flex-1 rounded-lg border-2 border-gray-300 py-3 font-semibold text-gray-700 transition hover:bg-gray-50 disabled:opacity-50"
                                >
                                    Cancel
                                </button>
                            </div>
                        )}
                    </form>
                </motion.div>

                {/* Account Stats Card */}
                <motion.div
                    className="mt-6 grid gap-6 md:grid-cols-3"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, delay: 0.2 }}
                >
                    <div className="rounded-lg bg-white p-6 text-center shadow-lg">
                        <div className="text-caramel mb-2 text-3xl font-bold">
                            0
                        </div>
                        <div className="text-sm text-gray-600">
                            Coupons Used
                        </div>
                    </div>
                    <div className="rounded-lg bg-white p-6 text-center shadow-lg">
                        <div className="text-caramel mb-2 text-3xl font-bold">
                            $0
                        </div>
                        <div className="text-sm text-gray-600">
                            Total Saved
                        </div>
                    </div>
                    <div className="rounded-lg bg-white p-6 text-center shadow-lg">
                        <div className="text-caramel mb-2 text-3xl font-bold">
                            {session.user.role || 'USER'}
                        </div>
                        <div className="text-sm text-gray-600">Role</div>
                    </div>
                </motion.div>
            </div>
        </div>
    )
}
