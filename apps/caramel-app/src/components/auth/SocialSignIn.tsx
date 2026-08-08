'use client'

import { socialButtonClasses } from '@/components/auth/authStyles'
import { signIn } from '@/lib/auth/client'
import { useState } from 'react'
import { FaApple } from 'react-icons/fa'
import { FcGoogle } from 'react-icons/fc'
import { toast } from 'sonner'

type Provider = 'google' | 'apple'

const PROVIDER_LABEL: Record<Provider, string> = {
    google: 'Google',
    apple: 'Apple',
}

/**
 * Google + Apple buttons, shared by every auth page.
 *
 * The handler was previously duplicated in LoginPageClient and
 * SignupPageClient with only the toast wording differing. `verb` covers that
 * difference so there is one implementation of the redirect and its failure
 * handling.
 *
 * The Google mark is FcGoogle (the official four-colour G). It used to be
 * FaGoogle tinted `text-caramel`, i.e. a recoloured Google logo — which
 * Google's own branding guidelines for "Sign in with Google" do not permit.
 */
export default function SocialSignIn({
    verb = 'Sign in',
    callbackURL = '/',
}: {
    verb?: 'Sign in' | 'Sign up'
    callbackURL?: string
}) {
    const [pending, setPending] = useState<Provider | null>(null)

    const handle = async (provider: Provider) => {
        setPending(provider)
        try {
            const result = await signIn.social({ provider, callbackURL })
            if (result?.error) {
                toast.error(
                    `Unable to continue with ${PROVIDER_LABEL[provider]}. Please try again.`,
                )
                setPending(null)
                return
            }
            // On success signIn.social navigates away to the provider, so the
            // pending state intentionally stays set until the page unloads.
        } catch {
            toast.error('Something went wrong. Please try again later.')
            setPending(null)
        }
    }

    return (
        <div className="space-y-3">
            <button
                type="button"
                onClick={() => handle('google')}
                disabled={!!pending}
                className={socialButtonClasses}
            >
                <FcGoogle aria-hidden="true" className="h-5 w-5" />
                <span>
                    {pending === 'google'
                        ? 'Redirecting…'
                        : `${verb} with Google`}
                </span>
            </button>
            <button
                type="button"
                onClick={() => handle('apple')}
                disabled={!!pending}
                className={socialButtonClasses}
            >
                <FaApple
                    aria-hidden="true"
                    className="h-5 w-5 text-gray-900 dark:text-gray-100"
                />
                <span>
                    {pending === 'apple'
                        ? 'Redirecting…'
                        : `${verb} with Apple`}
                </span>
            </button>
        </div>
    )
}
