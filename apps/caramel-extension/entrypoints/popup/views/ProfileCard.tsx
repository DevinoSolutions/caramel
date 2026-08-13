import { signOutAndRevoke } from '../../../popup-core.js'
import { SavingsBanner } from '../components/SavingsBanner'
import type { AppApi, PopupUser } from '../types'

/**
 * Signed-in, no-active-tab surface (P2 React successor to popup.js
 * renderProfileCard). Reuses the coupons-view card language (avatar +
 * @username row + logout) so the two signed-in surfaces read as one design.
 * Logout goes through signOutAndRevoke — the busy-latch and the
 * always-clear-locally contract live THERE (pinned), the view only hands it
 * the clicked button and the after-callback (vanilla: initPopup → refresh).
 */
export function ProfileCard({ user, api }: { user: PopupUser; api: AppApi }) {
    const avatar = user.image?.length
        ? user.image
        : 'assets/default-profile.png'
    return (
        <div className="coupons-profile-card fade-in-up">
            <div className="coupons-profile-row">
                <div className="coupons-profile-info">
                    <img
                        src={avatar}
                        className="coupons-profile-image"
                        alt="avatar"
                    />
                    <span className="coupons-user-label">@{user.username}</span>
                </div>
                <button
                    type="button"
                    // The id is a consumer contract, not styling:
                    // scripts/test-extension.mjs waits on #logoutBtn after a
                    // live login, and this card is where a no-tab login lands.
                    id="logoutBtn"
                    className="coupons-logout-button"
                    onClick={e =>
                        signOutAndRevoke(api.refresh, e.currentTarget)
                    }
                >
                    Log out
                </button>
            </div>
            <SavingsBanner />
            <p className="profile-signed-in-note">
                You&apos;re signed in — coupons appear automatically at
                checkout.
            </p>
        </div>
    )
}
