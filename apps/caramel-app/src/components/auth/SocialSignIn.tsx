'use client'

import { socialButtonClasses } from '@/components/auth/authStyles'
import { trackGrowthEvent } from '@/lib/analytics/growthEvents'
import { signIn } from '@/lib/auth/client'
import { useEffect, useRef, useState } from 'react'
import { FaApple } from 'react-icons/fa'
import { FcGoogle } from 'react-icons/fc'
import { toast } from 'sonner'

type Provider = 'google' | 'apple'

// How long a successful signIn.social may leave the page before we decide the
// navigation was abandoned and give the buttons back. Measured in desktop
// Safari (2026-10-17): the Apple redirect opens Safari's NATIVE "Sign in with
// Apple" sheet instead of loading appleid.apple.com, and cancelling it fires
// no event at all on the page (no focus, blur, visibilitychange or pageshow) —
// the page just stays, so elapsed time is the only signal there is. A normal
// redirect unloads the page well inside this window.
export const ABANDONED_REDIRECT_MS = 6000

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
    autoStart,
}: {
    verb?: 'Sign in' | 'Sign up'
    callbackURL?: string
    // When set, immediately launch that provider on mount, as if the matching
    // button were clicked. This is the extension deep-link: Safari/Firefox open
    // /login?provider=apple in a tab so the sign-in goes straight to the
    // provider with no extra tap. Only the two real providers are honored.
    autoStart?: Provider
}) {
    const [pending, setPending] = useState<Provider | null>(null)
    const abandonTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    useEffect(
        () => () => {
            if (abandonTimer.current) clearTimeout(abandonTimer.current)
        },
        [],
    )

    const handle = async (provider: Provider) => {
        setPending(provider)
        // Only the signup page is a signup funnel step; on /login the same
        // buttons sign existing users in (a first-time user there still gets
        // a server-side signup_completed).
        if (verb === 'Sign up') {
            trackGrowthEvent('signup_started', { method: provider })
        }
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
            // pending state stays set while the page unloads — unless the page
            // is still here after ABANDONED_REDIRECT_MS (a cancelled native
            // Apple sheet, a stopped load), when "Redirecting…" would
            // otherwise sit on disabled buttons until a reload.
            if (abandonTimer.current) clearTimeout(abandonTimer.current)
            abandonTimer.current = setTimeout(
                () => setPending(null),
                ABANDONED_REDIRECT_MS,
            )
        } catch {
            toast.error('Something went wrong. Please try again later.')
            setPending(null)
        }
    }

    // Fire the deep-linked provider exactly once. A ref, not state: React 18
    // StrictMode double-invokes effects in dev, and signIn.social kicks off a
    // navigation we must not start twice.
    const autoStarted = useRef(false)
    useEffect(() => {
        if (autoStart && !autoStarted.current) {
            autoStarted.current = true
            void handle(autoStart)
        }
    }, [autoStart])

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
