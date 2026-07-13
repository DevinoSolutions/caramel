'use client'

import { useSession } from '@/lib/auth/client'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

export default function ProfilePageClient() {
    const { data: session, isPending } = useSession()
    const router = useRouter()

    useEffect(() => {
        if (!isPending && !session?.user) {
            router.push('/login')
        }
    }, [session, isPending, router])

    if (isPending) {
        return (
            <main className="relative -mt-[6.7rem] w-full">
                <div className="container mx-auto px-4 py-16">
                    <div className="flex items-center justify-center">
                        <div className="text-lg">Loading...</div>
                    </div>
                </div>
            </main>
        )
    }

    if (!session?.user) {
        return null
    }

    const user = session.user
    const userInitial =
        user.name?.charAt(0).toUpperCase() ||
        user.email?.charAt(0).toUpperCase() ||
        'U'

    return (
        <main className="relative -mt-[6.7rem] w-full">
            <div className="container mx-auto px-4 py-16">
                <div className="mx-auto max-w-2xl">
                    <h1 className="mb-8 text-4xl font-bold text-caramel">
                        Profile
                    </h1>

                    <div className="rounded-2xl bg-white p-8 shadow-lg dark:bg-darkerBg">
                        <div className="mb-6 flex items-center gap-6">
                            <div className="flex h-20 w-20 items-center justify-center rounded-full bg-caramel text-2xl font-semibold text-white">
                                {userInitial}
                            </div>
                            <div>
                                <h2 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
                                    {user.firstName && user.lastName
                                        ? `${user.firstName} ${user.lastName}`
                                        : user.name}
                                </h2>
                                {user.email && (
                                    <p className="text-gray-600 dark:text-gray-200">
                                        {user.email}
                                    </p>
                                )}
                            </div>
                        </div>

                        <div className="space-y-4 border-t pt-6 dark:border-gray-700">
                            <div>
                                <label className="text-sm font-medium text-gray-500 dark:text-gray-400">
                                    Email
                                </label>
                                <p className="mt-1 text-gray-900 dark:text-gray-100">
                                    {user.email || 'Not provided'}
                                </p>
                            </div>

                            {user.name && (
                                <div>
                                    <label className="text-sm font-medium text-gray-500 dark:text-gray-400">
                                        Name
                                    </label>
                                    <p className="mt-1 text-gray-900 dark:text-gray-100">
                                        {user.name}
                                    </p>
                                </div>
                            )}

                            {(user.firstName || user.lastName) && (
                                <div>
                                    <label className="text-sm font-medium text-gray-500 dark:text-gray-400">
                                        First Name
                                    </label>
                                    <p className="mt-1 text-gray-900 dark:text-gray-100">
                                        {user.firstName || 'Not provided'}
                                    </p>
                                </div>
                            )}

                            {(user.firstName || user.lastName) && (
                                <div>
                                    <label className="text-sm font-medium text-gray-500 dark:text-gray-400">
                                        Last Name
                                    </label>
                                    <p className="mt-1 text-gray-900 dark:text-gray-100">
                                        {user.lastName || 'Not provided'}
                                    </p>
                                </div>
                            )}

                            {user.username && (
                                <div>
                                    <label className="text-sm font-medium text-gray-500 dark:text-gray-400">
                                        Username
                                    </label>
                                    <p className="mt-1 text-gray-900 dark:text-gray-100">
                                        {user.username}
                                    </p>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </main>
    )
}
