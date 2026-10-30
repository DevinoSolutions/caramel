'use client'

import ProfileSection from '@/components/profile/ProfileSection'
import { authClient } from '@/lib/auth/client'
import {
    connectErrorMessage,
    disconnectErrorMessage,
    signInMethodRows,
    type SignInMethodRow,
    type SocialSignInProvider,
} from '@/lib/auth/signInMethodRules'
import {
    bodyTextClasses,
    listRowClasses,
    secondaryButtonClasses,
} from '@/lib/profile/profileStyles'
import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'

/**
 * /profile > "Sign-in methods" (owner rule 2026-10-27: same email = same
 * account, and each person manages the ways into it). The rules (last method)
 * live in src/lib/auth/signInMethodRules.ts; this renders them.
 *
 * The list comes from GET /api/account/sign-in-methods (a password row a
 * take-back cleared is left out there). Connect is better-auth `linkSocial`,
 * a full-page redirect through the provider that comes back here with
 * `connect=done`, or `connect=failed` plus better-auth's `error` code; an
 * explicit Connect may link an address other than the account's (an Apple
 * Hide My Email relay). Disconnect is `unlinkAccount` by the row id, then the
 * list is re-read.
 */

type LinkedAccount = { id: string; providerId: string }

const PROVIDER_LABELS: Record<string, string> = {
    google: 'Google',
    apple: 'Apple',
    credential: 'Email and password',
}

const label = (row: SignInMethodRow) => PROVIDER_LABELS[row.id] ?? row.id

/** Reads and clears the `connect=` marker a Connect redirect came back with. */
function takeConnectOutcome(): { failed: boolean; error: string } | null {
    const url = new URL(window.location.href)
    const outcome = url.searchParams.get('connect')
    if (outcome !== 'done' && outcome !== 'failed') return null
    const error = url.searchParams.get('error') ?? ''
    url.searchParams.delete('connect')
    url.searchParams.delete('error')
    window.history.replaceState(window.history.state, '', url.toString())
    return { failed: outcome === 'failed' || error !== '', error }
}

async function fetchLinkedAccounts(): Promise<LinkedAccount[]> {
    const res = await fetch('/api/account/sign-in-methods', {
        cache: 'no-store',
    })
    if (!res.ok) throw new Error(`sign-in methods load failed (${res.status})`)
    const body = (await res.json()) as { accounts: LinkedAccount[] }
    return body.accounts
}

export default function SignInMethodsSection() {
    const [linked, setLinked] = useState<LinkedAccount[] | null>(null)
    const [loadFailed, setLoadFailed] = useState(false)
    const [busyId, setBusyId] = useState<string | null>(null)
    const [notice, setNotice] = useState<{
        tone: 'ok' | 'error'
        text: string
    } | null>(null)

    const load = useCallback(async () => {
        try {
            setLinked(await fetchLinkedAccounts())
            setLoadFailed(false)
        } catch (error) {
            console.error('[profile] sign-in methods load failed', error)
            setLoadFailed(true)
        }
    }, [])

    useEffect(() => {
        // Read before the first await, so a re-render cannot see it twice.
        const outcome = takeConnectOutcome()
        void load().then(() => {
            if (!outcome) return
            setNotice(
                outcome.failed
                    ? {
                          tone: 'error',
                          text: connectErrorMessage(outcome.error),
                      }
                    : { tone: 'ok', text: 'Connected.' },
            )
        })
    }, [load])

    const rows = useMemo(
        () =>
            linked === null
                ? []
                : signInMethodRows(linked.map(account => account.providerId)),
        [linked],
    )

    async function connect(provider: SocialSignInProvider) {
        setNotice(null)
        setBusyId(provider)
        const back = (outcome: string) =>
            `/profile?connect=${outcome}#sign-in-methods`
        const { error } = await authClient.linkSocial({
            provider,
            callbackURL: back('done'),
            errorCallbackURL: back('failed'),
        })
        // On success the browser is already leaving for the provider.
        if (error) {
            setBusyId(null)
            setNotice({
                tone: 'error',
                text: connectErrorMessage(error.code ?? ''),
            })
        }
    }

    async function disconnect(row: SignInMethodRow) {
        const account = linked?.find(
            candidate => candidate.providerId.toLowerCase() === row.id,
        )
        if (!account) return
        setNotice(null)
        setBusyId(row.id)
        try {
            const { error } = await authClient.unlinkAccount({
                accountId: account.id,
            })
            if (error) {
                setNotice({
                    tone: 'error',
                    text: disconnectErrorMessage(error.code, label(row)),
                })
                return
            }
            setNotice({ tone: 'ok', text: `${label(row)} disconnected.` })
            await load()
        } finally {
            setBusyId(null)
        }
    }

    const button = `${secondaryButtonClasses} min-h-[44px]`

    return (
        <ProfileSection
            id="sign-in-methods"
            title="Sign-in methods"
            description="Every way you sign in opens this same account."
        >
            {notice ? (
                <p
                    role="status"
                    className={`mb-4 text-sm ${
                        notice.tone === 'error'
                            ? 'text-red-700 dark:text-red-300'
                            : 'text-gray-700 dark:text-gray-300'
                    }`}
                >
                    {notice.text}
                </p>
            ) : null}
            {loadFailed ? (
                <p role="alert" className={bodyTextClasses}>
                    Your sign-in methods could not be loaded.{' '}
                    <button
                        type="button"
                        onClick={() => void load()}
                        className="text-caramel min-h-[44px] font-semibold hover:underline"
                    >
                        Try again
                    </button>
                </p>
            ) : linked === null ? (
                <p className={bodyTextClasses}>Loading sign-in methods...</p>
            ) : (
                <ul>
                    {rows.map(row => {
                        const noteId = `sign-in-method-${row.id}-note`
                        const note = row.isLastMethod
                            ? 'This is your only way to sign in, so it cannot be disconnected. Connect another method first.'
                            : null
                        return (
                            <li
                                key={row.id}
                                className={`${listRowClasses} flex-wrap justify-between`}
                            >
                                <div className="min-w-0 flex-1 basis-56">
                                    <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                                        {label(row)}{' '}
                                        <span className="font-normal text-gray-600 dark:text-gray-400">
                                            {row.connected
                                                ? 'Connected'
                                                : 'Not connected'}
                                        </span>
                                    </p>
                                    {note ? (
                                        <p
                                            id={noteId}
                                            className="mt-0.5 text-xs text-gray-600 dark:text-gray-400"
                                        >
                                            {note}
                                        </p>
                                    ) : null}
                                </div>
                                {row.connected ? (
                                    <button
                                        type="button"
                                        aria-label={`Disconnect ${label(row)}`}
                                        aria-describedby={
                                            note ? noteId : undefined
                                        }
                                        disabled={
                                            !row.canDisconnect ||
                                            busyId !== null
                                        }
                                        onClick={() => void disconnect(row)}
                                        className={button}
                                    >
                                        {busyId === row.id
                                            ? 'Disconnecting...'
                                            : 'Disconnect'}
                                    </button>
                                ) : null}
                                {row.canConnect ? (
                                    <button
                                        type="button"
                                        aria-label={`Connect ${label(row)}`}
                                        disabled={busyId !== null}
                                        onClick={() =>
                                            void connect(
                                                row.id as SocialSignInProvider,
                                            )
                                        }
                                        className={button}
                                    >
                                        {busyId === row.id
                                            ? 'Connecting...'
                                            : 'Connect'}
                                    </button>
                                ) : null}
                                {row.isPassword && !row.connected ? (
                                    <Link
                                        href="/forgot-password"
                                        className={button}
                                    >
                                        Set a password
                                    </Link>
                                ) : null}
                            </li>
                        )
                    })}
                </ul>
            )}
        </ProfileSection>
    )
}
