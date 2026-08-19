import { useCallback, useEffect, useState } from 'react'
import {
    requestAllSites,
    resolveAllSitesGranted,
} from '../../../permission-state.js'
import type { AllSitesGranted, AppApi } from '../types'

/**
 * The half-working install, which has no symptom of its own: the API is
 * reachable through an old narrow host grant, so coupons load and the popup
 * looks healthy, while the content script is dead on every store and
 * auto-apply silently never runs. Firefox auto-updates from <=1.0.3 kept
 * exactly four old host grants and produce this state on their own.
 *
 * Resolves its OWN state after mount rather than taking it from
 * resolvePopupState(). That is deliberate: this is an advisory strip above
 * content that already loaded, and the popup's boot must never wait on a
 * permissions API answering. A runtime whose `contains()` never calls back
 * would otherwise hold the spinner up over a perfectly good coupon list.
 *
 * Renders on an explicit `false` ONLY. `null` means the runtime would not tell
 * us whether the grant exists, and warning a working install about a
 * permission it already has is worse than staying quiet.
 */
export function AllSitesBanner({ api }: { api: AppApi }) {
    const [granted, setGranted] = useState<AllSitesGranted>(null)

    // Re-read rather than assume: the prompt's own answer says what the USER
    // clicked, and `contains()` says what the browser actually recorded —
    // Safari can hand back something narrower than it was asked for.
    const recheck = useCallback(() => {
        let alive = true
        void resolveAllSitesGranted().then((value: AllSitesGranted) => {
            if (alive) setGranted(value)
        })
        return () => {
            alive = false
        }
    }, [])

    useEffect(() => recheck(), [recheck])

    if (granted !== false) return null
    return (
        <div className="all-sites-banner">
            <p>Caramel can&apos;t run on every store yet.</p>
            <button
                type="button"
                id="allSitesEnableBtn"
                className="all-sites-banner-btn"
                onClick={() =>
                    requestAllSites(() => {
                        recheck()
                        // The rest of the popup was resolved without the grant;
                        // re-run it now that stores are reachable.
                        api.refresh()
                    })
                }
            >
                Enable
            </button>
        </div>
    )
}
