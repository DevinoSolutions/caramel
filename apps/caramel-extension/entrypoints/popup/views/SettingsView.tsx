import { useEffect, useState } from 'react'
import {
    caramelGetSession,
    caramelGetSettings,
    caramelSendMessage,
    caramelSetSettings,
    caramelSyncSavings,
} from '../../../caramel-base.js'
import { caramelUrl } from '../../../popup-core.js'
import { SavingsBanner } from '../components/SavingsBanner'
import { useToast } from '../components/toast'
import type { AppApi, PopupUser } from '../types'

/**
 * In-popup extension preferences (P2 React successor to popup.js
 * renderSettingsView): the global checkout-prompt toggle and a
 * pause-this-site toggle, persisted via caramelSetSettings (storage.sync, so
 * they roam with the browser profile); the checkout pill honors them in
 * insertCaramelPrompt(). Guests get it too — the checkout-prompt toggle
 * matters most to signed-out users.
 */
interface Settings {
    autoApply: boolean
    disabledSites: string[]
    syncSavings: boolean
}

export function SettingsView({
    domain,
    api,
}: {
    user: PopupUser | null
    domain?: string
    api: AppApi
}) {
    const showToast = useToast()
    const [settings, setSettings] = useState<Settings | null>(null)
    // The session TOKEN is the gate, not the resolved user object: a session
    // can carry a token with no user record, and that account still has
    // savings to sync to.
    const [hasAccount, setHasAccount] = useState(false)
    const [syncSavings, setSyncSavings] = useState(false)
    const [syncBusy, setSyncBusy] = useState(false)
    const [syncStatus, setSyncStatus] = useState('')

    useEffect(() => {
        let alive = true
        void Promise.all([
            caramelGetSettings(),
            caramelGetSession().catch(() => null),
        ]).then(([loaded, session]: [Settings, { token?: string } | null]) => {
            if (!alive) return
            setSettings(loaded)
            setSyncSavings(loaded.syncSavings)
            setHasAccount(!!session?.token)
        })
        return () => {
            alive = false
        }
    }, [])

    // Dot-less "domains" are extension pages (the popup opened as a tab /
    // login window reports its own chrome-extension host) — no site toggle.
    const site =
        domain && domain.includes('.')
            ? domain.toLowerCase().replace(/^www\./, '')
            : null
    const sitePaused = !!(
        site &&
        settings?.disabledSites.some(d => site === d || site.endsWith('.' + d))
    )

    // Vanilla awaited settings + session before painting anything; nothing here
    // may render an unchecked switch it is about to correct.
    if (!settings) return null

    const toggleAutoApply = (checked: boolean) => {
        setSettings({ ...settings, autoApply: checked })
        void caramelSetSettings({ autoApply: checked })
    }

    const toggleSite = async (checked: boolean) => {
        if (!site) return
        const current: Settings = await caramelGetSettings()
        const rest = current.disabledSites.filter(d => d !== site)
        const disabledSites = checked ? [...rest, site] : rest
        setSettings(previous => previous && { ...previous, disabledSites })
        await caramelSetSettings({ disabledSites })
    }

    /* Savings sync. The ACCOUNT column is the authority, so: server first,
     * device cache second — writing the local flag up front and reconciling
     * later would leave a device claiming consent the account never recorded,
     * and that flag is what gates every upload. On failure the switch goes back
     * where it was: this one governs whether a shopping record leaves the
     * device, so it must never overstate what happened. */
    const toggleSyncSavings = async (requested: boolean) => {
        setSyncSavings(requested)
        setSyncBusy(true)
        let resp: { error?: string; savingsSyncEnabled?: boolean } | null = null
        try {
            resp = await caramelSendMessage({
                action: 'setSavingsSync',
                enabled: requested,
            })
        } catch (err) {
            resp = { error: String(err) }
        }
        setSyncBusy(false)

        if (
            !resp ||
            resp.error ||
            typeof resp.savingsSyncEnabled !== 'boolean'
        ) {
            setSyncSavings(!requested)
            const message = 'Couldn’t change that setting. Please try again.'
            setSyncStatus(message)
            showToast(message)
            return
        }

        const enabled: boolean = resp.savingsSyncEnabled
        setSyncSavings(enabled)
        await caramelSetSettings({ syncSavings: enabled })
        setSyncStatus(enabled ? 'Savings sync is on' : 'Savings sync is off')
        // Turning it on flushes anything already queued on this device.
        if (enabled) void caramelSyncSavings()
    }

    return (
        <div className="settings-view fade-in-up">
            <h3 className="settings-title">Settings</h3>

            <label className="settings-row">
                <span className="settings-copy">
                    <span>Checkout prompt</span>
                    <small>Offer to auto-apply the best code at checkout</small>
                </span>
                <input
                    type="checkbox"
                    id="autoApplyToggle"
                    className="settings-switch"
                    checked={settings.autoApply}
                    onChange={e => toggleAutoApply(e.target.checked)}
                />
            </label>

            {site && (
                <label className="settings-row">
                    <span className="settings-copy">
                        <span>Pause on {site}</span>
                        <small>Don&apos;t show the prompt on this site</small>
                    </span>
                    <input
                        type="checkbox"
                        id="siteToggle"
                        className="settings-switch"
                        checked={sitePaused}
                        onChange={e => void toggleSite(e.target.checked)}
                    />
                </label>
            )}

            {/* Savings sync needs an account to sync TO, so the row is
                signed-in only — the gate #accountLink already uses. A guest
                tapping a switch that can only bounce them into sign-in is a
                dead end. */}
            {hasAccount && (
                <>
                    <label className="settings-row">
                        <span className="settings-copy">
                            <span>Sync my savings</span>
                            <small>
                                Keep your savings on your Caramel account, not
                                just this device
                            </small>
                        </span>
                        <input
                            type="checkbox"
                            id="syncSavingsToggle"
                            className="settings-switch"
                            role="switch"
                            checked={syncSavings}
                            disabled={syncBusy}
                            onChange={e =>
                                void toggleSyncSavings(e.target.checked)
                            }
                        />
                    </label>
                    <span
                        id="syncSavingsStatus"
                        role="status"
                        aria-live="polite"
                        style={{
                            position: 'absolute',
                            width: '1px',
                            height: '1px',
                            overflow: 'hidden',
                            clipPath: 'inset(50%)',
                            whiteSpace: 'nowrap',
                        }}
                    >
                        {syncStatus}
                    </span>
                </>
            )}

            <SavingsBanner />

            {hasAccount && (
                <a
                    id="accountLink"
                    className="account-link"
                    href={caramelUrl('profile#savings')}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ display: 'inline-block' }}
                >
                    Manage account →
                </a>
            )}

            <button
                id="backBtn"
                className="back-btn"
                type="button"
                onClick={api.closeOverlay}
            >
                ← Back
            </button>
        </div>
    )
}
