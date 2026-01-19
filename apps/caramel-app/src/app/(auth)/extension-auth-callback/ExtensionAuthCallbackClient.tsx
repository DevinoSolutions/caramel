'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

export default function ExtensionAuthCallbackClient() {
    const [status, setStatus] = useState<'loading' | 'success' | 'error'>(
        'loading',
    )
    const router = useRouter()

    useEffect(() => {
        const handleAuthCallback = async () => {
            try {
                // Get the session to verify authentication
                const response = await fetch('/api/auth/get-session')
                const data = await response.json()

                if (data.session && data.user) {
                    // Send token to extension via postMessage
                    if (window.opener) {
                        window.opener.postMessage(
                            {
                                type: 'oauth-success',
                                token: data.session.token,
                                user: {
                                    username: data.user.name || data.user.email,
                                    image: data.user.image || '',
                                },
                            },
                            '*', // In production, specify your extension's origin
                        )
                        setStatus('success')
                        // Close window after a short delay
                        setTimeout(() => {
                            window.close()
                        }, 1500)
                    } else {
                        // No opener, redirect to home
                        router.push('/')
                    }
                } else {
                    setStatus('error')
                }
            } catch (error) {
                console.error('Auth callback error:', error)
                setStatus('error')
            }
        }

        handleAuthCallback()
    }, [router])

    return (
        <div className="flex h-screen items-center justify-center bg-gray-50">
            <div className="rounded-lg bg-white p-8 shadow-lg text-center">
                {status === 'loading' && (
                    <>
                        <div className="mb-4">
                            <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-orange-500 border-r-transparent"></div>
                        </div>
                        <p className="text-gray-600">Completing sign in...</p>
                    </>
                )}
                {status === 'success' && (
                    <>
                        <div className="mb-4 text-5xl">✓</div>
                        <p className="text-gray-600">
                            Successfully signed in! This window will close
                            automatically.
                        </p>
                    </>
                )}
                {status === 'error' && (
                    <>
                        <div className="mb-4 text-5xl text-red-500">✕</div>
                        <p className="text-gray-600">
                            Authentication failed. Please try again.
                        </p>
                        <button
                            onClick={() => window.close()}
                            className="mt-4 rounded-md bg-orange-500 px-4 py-2 text-white hover:bg-orange-600"
                        >
                            Close
                        </button>
                    </>
                )}
            </div>
        </div>
    )
}
