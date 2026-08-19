import { Button } from 'caramel-ui'
import { isSafariExtensionRuntime } from '../../../caramel-base.js'
import { requestAllSites } from '../../../permission-state.js'
import type { AppApi } from '../types'

/**
 * The browser refused our requests: the every-website host grant is missing,
 * so the background fetch never left the machine and LoadErrorView used to
 * paint "Check your connection and try again" over a perfectly good
 * connection. Two real cohorts land here — Firefox auto-updates from <=1.0.3,
 * which silently kept only the four old narrow host grants, and fresh installs
 * where the grant is left unchecked.
 *
 * Modelled on LoadErrorView: same `.no-coupons-view` shell, same illustration
 * disc, same single caramel-ui action. The difference is that this one is
 * FIXABLE from inside the popup, so the button asks for the grant instead of
 * retrying a request that cannot succeed.
 */
export function PermissionView({ api }: { api: AppApi }) {
    // Safari's request() may hand back a narrower grant than it was asked for
    // (or nothing at all) — the every-website state really lives behind its
    // own menus, so it gets the manual route spelled out under the button
    // rather than a prompt that can silently do nothing.
    const safari = isSafariExtensionRuntime()

    return (
        <div className="no-coupons-view fade-in-up">
            <div className="empty-illu" aria-hidden="true">
                <svg
                    width="28"
                    height="28"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#ea6925"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    <rect x="4" y="10.5" width="16" height="10" rx="2" />
                    <path d="M8 10.5V7a4 4 0 0 1 8 0" />
                    <path d="M12 14.5v2" />
                </svg>
            </div>
            <h3>Enable Caramel to get started</h3>
            <p>
                Your browser has site access turned off for Caramel, so it
                can&apos;t reach our coupons or run on the stores you visit. One
                click turns it back on.
            </p>
            <div className="no-coupons-actions">
                <Button
                    variant="primary"
                    onClick={() => requestAllSites(api.refresh)}
                >
                    Enable Caramel
                </Button>
            </div>
            {safari && (
                <p className="permission-manual-note">
                    If nothing happens, set it yourself: on Mac, click the
                    Caramel button in the toolbar and choose{' '}
                    <strong>Always Allow on Every Website</strong>. On iPhone or
                    iPad, tap <strong>AA</strong> in the address bar, choose
                    Caramel, then <strong>Always Allow</strong>.
                </p>
            )}
        </div>
    )
}
