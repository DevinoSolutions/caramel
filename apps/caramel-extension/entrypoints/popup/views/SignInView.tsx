import type { AppApi } from '../types'

/**
 * TODO(WXT-P2 agent D): PLACEHOLDER — the sign-in view is NOT built yet.
 *
 * The real view ports popup.js renderSignInPrompt per P2-POPUP-SPEC.md
 * invariants 2–4: provider buttons drive popup-core's runSocialSignIn with
 * an {onPending,onError} ui (both disabled in flight, clicked one labeled
 * 'Redirecting...'), the popupOAuthSupported() capability branch swaps them
 * to openWebsiteSignIn + the grabcaramel.com note, and the email form keeps
 * the pinned error copy INCLUDING the conscious `Login failed: Login failed`
 * stutter and the verify-shaped resend link. Back = api.closeOverlay. It
 * re-enables the .p2disabled suites: popup-email-login, popup-signin-widgets
 * (plus the already-ported oauth suites' UI halves).
 *
 * If you are reading this on main, the port was dropped: treat it as a
 * release blocker, not a cleanup item.
 */
export function SignInView(_props: { api: AppApi }) {
    return (
        <div className="no-coupons-view">
            <h3>Sign-in view under construction</h3>
            <p>WXT-P2 agent D owns this surface — see the TODO above.</p>
        </div>
    )
}
