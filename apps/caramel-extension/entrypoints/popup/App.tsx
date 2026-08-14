import { Spinner } from 'caramel-ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
    resolvePopupState,
    resumeSafariOauthIfPending,
    setAfterLoginRerender,
} from '../../popup-core.js'
import { ToastProvider } from './components/toast'
import type { AppApi, ResolvedState } from './types'
import { CouponsView } from './views/CouponsView'
import { LoadErrorView } from './views/LoadErrorView'
import { ProfileCard } from './views/ProfileCard'
import { SettingsView } from './views/SettingsView'
import { SignInView } from './views/SignInView'
import { UnsupportedView } from './views/UnsupportedView'

/**
 * The popup's state machine (P2): popup-core's resolvePopupState() picks WHAT
 * to show (coupons | unsupported | profile | loadError — all its branching is
 * pinned), this component decides WHEN, plus the two overlays the vanilla
 * popup reached by repainting #auth-container: signin and settings. Back from
 * an overlay = clear it; the resolved view underneath was never torn down.
 *
 * Boot parity (vanilla initPopupEntry): the loader shows for AT LEAST 400ms
 * (anti-flicker floor) AND until the first resolve lands. Refreshes after
 * boot keep the current view painted until the new state arrives — re-inits
 * never flashed the skeleton, so neither does refresh().
 */
type Overlay = 'signin' | 'settings' | null

// popup-core.js is plain JS (checkJs off), so tsc widens its `view` literals
// to string; this is the ONE place the popup asserts the pinned shape. If
// resolvePopupState ever grows a view this union doesn't know, the render
// switch below falls through to null — add it to types.ts, not here.
const resolveState = (onSessionInvalid: () => void) =>
    resolvePopupState(onSessionInvalid) as Promise<ResolvedState>

export function App() {
    const [resolved, setResolved] = useState<ResolvedState | null>(null)
    const [booted, setBooted] = useState(false)
    const [overlay, setOverlay] = useState<Overlay>(null)

    // A slow older resolve must never clobber a newer one (e.g. retry clicked
    // twice, or a 401-triggered refresh racing a manual one).
    const runSeq = useRef(0)
    const refreshRef = useRef<() => void>(() => {})

    const refresh = useCallback(() => {
        const seq = ++runSeq.current
        // onSessionInvalid: a dead session re-resolves logged-out, exactly the
        // vanilla caramelClearSession(() => initPopup()) loop.
        void resolveState(() => refreshRef.current()).then(next => {
            if (runSeq.current !== seq) return
            setResolved(next)
            // A refresh lands on the RESOLVED view — vanilla re-inits
            // always repainted over whatever overlay was up.
            setOverlay(null)
        })
    }, [])
    refreshRef.current = refresh

    useEffect(() => {
        // Login success without a caller tab re-resolves this popup — the
        // registration the caller-relay pins require at boot.
        setAfterLoginRerender(() => refreshRef.current())

        const seq = ++runSeq.current
        const minDisplay = new Promise(r => setTimeout(r, 400))
        const first = resolveState(() => refreshRef.current()).then(next => {
            if (runSeq.current === seq) setResolved(next)
        })
        void Promise.all([first, minDisplay]).then(() => setBooted(true))

        // Safari finishes OAuth in a TAB, which closes this popup mid-flow —
        // the token is waiting server-side under the stored nonce when the user
        // reopens us. Deliberately NOT awaited into the boot gate: it can poll
        // for up to 30s, and the popup must paint immediately. Resolves to
        // 'idle' in every other runtime, so no other boot path changes.
        void resumeSafariOauthIfPending().then(result => {
            if (result.status === 'ok') refreshRef.current()
        })
    }, [])

    const api: AppApi = {
        openSignIn: () => setOverlay('signin'),
        closeOverlay: () => setOverlay(null),
        refresh,
    }

    // Vanilla contract: the gear is hidden by default, shown by every view
    // that wires it (coupons/unsupported/profile/settings), hidden again by
    // the sign-in prompt, and never wired by renderLoadError.
    const gearVisible =
        booted &&
        overlay !== 'signin' &&
        (overlay === 'settings' ||
            (resolved !== null && resolved.view !== 'loadError'))

    const domain =
        resolved &&
        (resolved.view === 'coupons' || resolved.view === 'unsupported')
            ? resolved.domain
            : undefined

    return (
        <ToastProvider>
            {/* The vanilla skeleton carried aria-hidden (decorative ghosts);
                the Spinner is a real role=status announcement, so the
                container must stay in the accessibility tree. */}
            {!booted && (
                <div id="loading-container" className="loading-container">
                    <Spinner label="Loading coupons…" size={28} />
                </div>
            )}
            <div className="popup-container">
                <header className="popup-header">
                    <a
                        href="https://grabcaramel.com"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        <img
                            src="/assets/logo-full.svg"
                            alt="Caramel Logo"
                            className="popup-logo"
                        />
                    </a>
                    {gearVisible && (
                        <button
                            type="button"
                            id="settingsIcon"
                            className="profile-settings"
                            aria-label="Open settings"
                            // styles.css hides .profile-settings by default;
                            // vanilla wireSettingsGear overrode it exactly so.
                            style={{ display: 'block' }}
                            onClick={() => setOverlay('settings')}
                        >
                            <svg
                                width="20"
                                height="20"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                aria-hidden="true"
                            >
                                <circle cx="12" cy="12" r="3" />
                                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                            </svg>
                        </button>
                    )}
                </header>

                <main id="mainContent">
                    <div id="auth-container">
                        {overlay === 'signin' ? (
                            <SignInView api={api} />
                        ) : overlay === 'settings' ? (
                            <SettingsView
                                user={
                                    resolved &&
                                    (resolved.view === 'coupons' ||
                                        resolved.view === 'unsupported' ||
                                        resolved.view === 'profile')
                                        ? resolved.user
                                        : null
                                }
                                domain={domain}
                                api={api}
                            />
                        ) : resolved?.view === 'coupons' ? (
                            <CouponsView
                                coupons={resolved.coupons}
                                user={resolved.user}
                                domain={resolved.domain}
                                page={resolved.page}
                                api={api}
                            />
                        ) : resolved?.view === 'unsupported' ? (
                            <UnsupportedView
                                // Remount on identity change so the local
                                // logged-out state never leaks across resolves.
                                key={`${resolved.domain ?? ''}:${resolved.user?.username ?? ''}`}
                                user={resolved.user}
                                domain={resolved.domain}
                                api={api}
                            />
                        ) : resolved?.view === 'profile' ? (
                            <ProfileCard user={resolved.user} api={api} />
                        ) : resolved?.view === 'loadError' ? (
                            <LoadErrorView onRetry={refresh} />
                        ) : null}
                    </div>
                </main>
            </div>
        </ToastProvider>
    )
}
