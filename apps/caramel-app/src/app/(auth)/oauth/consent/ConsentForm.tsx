'use client'

// The interactive half of /oauth/consent (page.tsx settles who is asking and
// for which account before this renders).
//
// Allow posts the signed query VERBATIM (window.location.search) to
// better-auth's consent endpoint with the scopes the user left ticked, then
// follows the redirect it returns (the AI app's callback with the code).
// Cancel posts accept: false, which redirects back with access_denied.
import AuthCard from '@/components/auth/AuthCard'
import { linkClasses, primaryButtonClasses } from '@/components/auth/authStyles'
import { signOut } from '@/lib/auth/client'
import { TIER_SCOPE, type McpTier } from '@/lib/mcp/oauthConfig'
import * as Sentry from '@sentry/nextjs'
import { useRef, useState } from 'react'

export type ConsentTierRow = {
    tier: McpTier
    label: string
    detail: string
    warning?: string
    checked: boolean
}

const secondaryButtonClasses =
    'w-full rounded-xl border border-gray-300 bg-white py-3 font-semibold text-gray-700 shadow-sm transition duration-200 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel/50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-darkBg dark:text-gray-200 dark:hover:bg-gray-900'

/** What a refused consent POST says; the recovery is back in the AI app. */
function failureNotice(errorCode: string | undefined, appName: string): string {
    const app = appName || 'the app you came from'
    switch (errorCode) {
        case 'request_expired':
        case 'invalid_signature':
            return `This connection request has expired. Go back to ${app} and connect again.`
        case 'not_authenticated':
            return 'Your session ended before this could be approved. Sign in again and reconnect from your AI app.'
        default:
            return `We could not complete this connection. Go back to ${app} and connect again.`
    }
}

export default function ConsentForm({
    invalid = false,
    heading,
    appName,
    trust,
    accountEmail,
    redirectUri,
    identityScopes,
    rows,
}: {
    invalid?: boolean
    heading: string
    appName: string
    trust: 'verified' | 'recognized' | 'unverified'
    accountEmail: string
    redirectUri: string
    /** openid/profile/email/offline_access as requested; always granted. */
    identityScopes: readonly string[]
    rows: readonly ConsentTierRow[]
}) {
    const [checked, setChecked] = useState<ReadonlySet<McpTier>>(
        () => new Set(rows.filter(row => row.checked).map(row => row.tier)),
    )
    const [addressConfirmed, setAddressConfirmed] = useState(false)
    const [submitting, setSubmitting] = useState<'accept' | 'deny' | null>(null)
    const [notice, setNotice] = useState('')
    // Several clicks can land before React re-renders; a ref closes the
    // door in the same tick.
    const submittedRef = useRef(false)

    if (invalid) {
        return (
            <AuthCard
                title={heading}
                subtitle="Start the connection again from your AI app."
            >
                {null}
            </AuthCard>
        )
    }

    const unverified = trust === 'unverified'
    const locked = submitting !== null || notice !== ''

    function toggle(tier: McpTier) {
        setChecked(previous => {
            const next = new Set(previous)
            if (next.has(tier)) next.delete(tier)
            else next.add(tier)
            return next
        })
    }

    async function submit(accept: boolean) {
        if (submittedRef.current) return
        submittedRef.current = true
        setSubmitting(accept ? 'accept' : 'deny')
        try {
            const scope = [
                ...identityScopes,
                ...rows
                    .filter(row => checked.has(row.tier))
                    .map(row => TIER_SCOPE[row.tier]),
            ].join(' ')
            const res = await fetch('/api/auth/oauth2/consent', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    accept,
                    oauth_query: window.location.search.replace(/^\?/, ''),
                    ...(accept ? { scope } : {}),
                }),
            })
            if (!res.ok) {
                const refusal = (await res.json().catch(() => ({}))) as {
                    error?: string
                    code?: string
                }
                setSubmitting(null)
                setNotice(
                    failureNotice(
                        (refusal.error ?? refusal.code)?.toLowerCase(),
                        appName,
                    ),
                )
                return
            }
            const data = (await res.json()) as {
                url?: string
                redirect_uri?: string
            }
            const target = data.url ?? data.redirect_uri
            if (!target)
                throw new Error('The consent endpoint returned no redirect')
            window.location.href = target
        } catch (error) {
            Sentry.captureException(error, {
                tags: { surface: 'oauth-consent' },
            })
            submittedRef.current = false
            setSubmitting(null)
            setNotice(failureNotice(undefined, appName))
        }
    }

    async function switchAccount() {
        const query = window.location.search
        try {
            await signOut()
        } catch (error) {
            Sentry.captureException(error, {
                tags: { surface: 'oauth-consent-switch-account' },
            })
        }
        // Full navigation with the signed query intact: the login page
        // resumes this same authorize request for the other account.
        window.location.assign(`/login${query}`)
    }

    return (
        <AuthCard
            title={heading}
            subtitle={
                trust === 'verified'
                    ? `Caramel recognizes ${appName}.`
                    : 'Only allow apps you trust.'
            }
        >
            <div className="mt-6 flex items-center justify-between gap-3 rounded-xl bg-gray-50 px-4 py-3 text-sm dark:bg-gray-900">
                <span
                    data-testid="consent-account"
                    className="min-w-0 truncate text-gray-700 dark:text-gray-200"
                >
                    {accountEmail}
                </span>
                <button
                    type="button"
                    disabled={locked}
                    onClick={() => void switchAccount()}
                    className={linkClasses}
                >
                    Not you?
                </button>
            </div>

            <fieldset className="mt-5 flex flex-col gap-3" disabled={locked}>
                <legend className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                    {appName || 'This app'} will be able to:
                </legend>
                {rows.length === 0 ? (
                    <p className="text-sm text-gray-600 dark:text-gray-400">
                        Confirm who you are and see your name and email address.
                    </p>
                ) : (
                    rows.map(row => (
                        <label
                            key={row.tier}
                            className="flex cursor-pointer items-start gap-3 rounded-xl border border-gray-200 p-3 dark:border-gray-700"
                        >
                            <input
                                type="checkbox"
                                className="accent-caramel mt-1"
                                checked={checked.has(row.tier)}
                                onChange={() => toggle(row.tier)}
                                data-testid={`consent-tier-${row.tier}`}
                            />
                            <span className="flex flex-col">
                                <span className="font-medium text-gray-900 dark:text-white">
                                    {row.label}
                                </span>
                                <span className="text-sm text-gray-600 dark:text-gray-400">
                                    {row.detail}
                                </span>
                                {row.warning ? (
                                    <span className="text-sm font-medium text-amber-700 dark:text-amber-400">
                                        {row.warning}
                                    </span>
                                ) : null}
                            </span>
                        </label>
                    ))
                )}
            </fieldset>

            {unverified ? (
                <div
                    data-testid="redirect-confirm"
                    className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200"
                >
                    <p>
                        You will be sent back to{' '}
                        <code className="break-all font-mono">
                            {redirectUri}
                        </code>
                    </p>
                    <label className="mt-2 flex items-center gap-2 font-medium">
                        <input
                            type="checkbox"
                            checked={addressConfirmed}
                            disabled={locked}
                            onChange={event =>
                                setAddressConfirmed(event.target.checked)
                            }
                        />
                        I recognize this address
                    </label>
                </div>
            ) : null}

            {notice ? (
                <p
                    role="alert"
                    className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-center text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200"
                >
                    {notice}
                </p>
            ) : null}

            <div className="mt-6 grid grid-cols-2 gap-3">
                <button
                    type="button"
                    disabled={locked}
                    onClick={() => void submit(false)}
                    className={secondaryButtonClasses}
                >
                    {submitting === 'deny' ? 'Cancelling...' : 'Cancel'}
                </button>
                <button
                    type="button"
                    disabled={locked || (unverified && !addressConfirmed)}
                    onClick={() => void submit(true)}
                    className={primaryButtonClasses}
                    data-testid="consent-allow"
                >
                    {submitting === 'accept' ? 'Connecting...' : 'Allow access'}
                </button>
            </div>

            <p className="mt-4 text-center text-xs text-gray-500 dark:text-gray-400">
                You can disconnect it any time from your Caramel profile.
            </p>
        </AuthCard>
    )
}
