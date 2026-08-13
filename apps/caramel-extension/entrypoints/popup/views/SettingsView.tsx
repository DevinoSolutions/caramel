import type { AppApi, PopupUser } from '../types'

/**
 * TODO(WXT-P2 agent D): PLACEHOLDER — the settings view is NOT built yet.
 *
 * The real view ports popup.js renderSettingsView per P2-POPUP-SPEC.md
 * invariant 12: autoApply toggle; per-site pause toggle only when the domain
 * has a dot (lowercased, www-stripped, paused = exact or suffix match);
 * syncSavings row SIGNED-IN only with server-first setSavingsSync + revert on
 * failure + toast + SR status; savings summary; `profile#savings` account
 * link only with a token; Back = api.closeOverlay. Re-enables the
 * .p2disabled suites: popup-settings-view, popup-savings-sync-row.
 *
 * If you are reading this on main, the port was dropped: treat it as a
 * release blocker, not a cleanup item.
 */
export function SettingsView(_props: {
    user: PopupUser | null
    domain?: string
    api: AppApi
}) {
    return (
        <div className="no-coupons-view">
            <h3>Settings view under construction</h3>
            <p>WXT-P2 agent D owns this surface — see the TODO above.</p>
        </div>
    )
}
