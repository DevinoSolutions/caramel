'use client'

// "Connected AI apps": the AI apps (Claude, ChatGPT, Cursor...) this account
// connected to Caramel over MCP, with Disconnect. Loads its own list from
// GET /api/account/connected-apps; Disconnect is DELETE
// /api/account/connected-apps/:clientId, which also stops access tokens the
// app already holds (src/lib/mcp/connectedApps.ts).
import ConfirmDialog from '@/components/profile/ConfirmDialog'
import EmptyState from '@/components/profile/EmptyState'
import ProfileSection from '@/components/profile/ProfileSection'
import { promptSupportOnFailure } from '@/lib/feedback/promptSupportOnFailure'
import type { ConnectedApp } from '@/lib/mcp/connectedApps'
import {
    listRowClasses,
    secondaryButtonClasses,
} from '@/lib/profile/profileStyles'
import { useEffect, useState } from 'react'
import { HiOutlineSparkles } from 'react-icons/hi'
import { toast } from 'sonner'

type LoadState =
    | { status: 'loading' }
    | { status: 'error' }
    | { status: 'ready'; apps: ConnectedApp[] }

export default function ConnectedAppsSection() {
    const [state, setState] = useState<LoadState>({ status: 'loading' })
    const [pending, setPending] = useState<ConnectedApp | null>(null)
    const [busy, setBusy] = useState(false)

    useEffect(() => {
        let cancelled = false
        fetch('/api/account/connected-apps', { credentials: 'include' })
            .then(async res => {
                if (!res.ok) {
                    throw new Error(`connected-apps GET failed: ${res.status}`)
                }
                const body = (await res.json()) as { apps: ConnectedApp[] }
                if (!cancelled) setState({ status: 'ready', apps: body.apps })
            })
            .catch((error: unknown) => {
                if (cancelled) return
                setState({ status: 'error' })
                promptSupportOnFailure({
                    error,
                    operation: 'connected_apps_load',
                })
            })
        return () => {
            cancelled = true
        }
    }, [])

    async function disconnect(app: ConnectedApp) {
        setBusy(true)
        try {
            const res = await fetch(
                `/api/account/connected-apps/${encodeURIComponent(app.clientId)}`,
                { method: 'DELETE', credentials: 'include' },
            )
            if (!res.ok && res.status !== 404) {
                throw new Error(`connected-apps DELETE failed: ${res.status}`)
            }
            setState(previous =>
                previous.status === 'ready'
                    ? {
                          status: 'ready',
                          apps: previous.apps.filter(
                              a => a.clientId !== app.clientId,
                          ),
                      }
                    : previous,
            )
            toast.success(`${app.name} is disconnected.`)
            setPending(null)
        } catch (error) {
            toast.error(`Couldn't disconnect ${app.name}. Try again.`)
            promptSupportOnFailure({
                error,
                operation: 'connected_app_disconnect',
            })
        } finally {
            setBusy(false)
        }
    }

    return (
        <ProfileSection
            id="connected-apps"
            title="Connected AI apps"
            description="AI apps you allowed to use your Caramel account, such as Claude or ChatGPT."
        >
            {state.status === 'loading' ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                    Loading...
                </p>
            ) : state.status === 'error' ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                    Your connected apps could not be loaded. Reload the page to
                    try again.
                </p>
            ) : state.apps.length === 0 ? (
                <EmptyState
                    icon={<HiOutlineSparkles aria-hidden="true" />}
                    heading="No AI apps connected"
                    body="Connect Caramel to Claude, ChatGPT or another AI app with the MCP address on the Caramel docs page."
                />
            ) : (
                <ul className="flex flex-col gap-2">
                    {state.apps.map(app => (
                        <li
                            key={app.clientId}
                            className={`${listRowClasses} flex items-center justify-between gap-4`}
                            data-testid="connected-app"
                        >
                            <div className="min-w-0">
                                <p className="truncate font-medium text-gray-900 dark:text-white">
                                    {app.name}
                                </p>
                                <p className="text-sm text-gray-600 dark:text-gray-400">
                                    {app.scopes
                                        .map(scope => scope.label)
                                        .join(' · ')}
                                </p>
                                <p className="text-xs text-gray-500 dark:text-gray-500">
                                    Connected{' '}
                                    {new Date(
                                        app.connectedAt,
                                    ).toLocaleDateString()}
                                </p>
                            </div>
                            <button
                                type="button"
                                className={secondaryButtonClasses}
                                onClick={() => setPending(app)}
                            >
                                Disconnect
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            <ConfirmDialog
                open={pending !== null}
                onClose={() => setPending(null)}
                onConfirm={() => (pending ? disconnect(pending) : undefined)}
                title={`Disconnect ${pending?.name ?? 'this app'}?`}
                body={`${pending?.name ?? 'This app'} will lose access to your Caramel account right away. You can connect it again later.`}
                confirmLabel="Disconnect"
                tone="danger"
                busy={busy}
            />
        </ProfileSection>
    )
}
