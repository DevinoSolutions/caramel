import { useEffect, useState } from 'react'
import {
    caramelDomainIsSupported,
    caramelUrl,
    signOutAndRevoke,
} from '../../../popup-core.js'
import { AllSitesBanner } from '../components/AllSitesBanner'
import type { AppApi, PopupUser } from '../types'

/**
 * The no-coupons / no-site view (P2 React successor to popup.js
 * renderUnsupportedSite). Three different facts get three different
 * sentences:
 *  - no domain at all (new tab, PDF, settings page) → "Ready when you are"
 *    plus the product explainer — the only place the popup says what Caramel
 *    IS, and the most likely first thing a new user ever sees;
 *  - a domain we don't cover → "No coupons for this site yet";
 *  - a domain we DO cover with nothing working (resolved asynchronously
 *    AFTER paint; a failed lookup asserts NOTHING) → "No working codes right
 *    now", and the "see the stores we support" link is removed because its
 *    whole premise is that this store isn't on the list.
 */
export function UnsupportedView({
    user: initialUser,
    domain,
    api,
}: {
    user: PopupUser | null
    domain?: string
    api: AppApi
}) {
    // Local, not a refresh: vanilla logout on this view re-painted the SAME
    // view logged-out without refetching coupons.
    const [user, setUser] = useState(initialUser)
    const [coveredButDry, setCoveredButDry] = useState(false)

    useEffect(() => {
        let alive = true
        caramelDomainIsSupported(domain).then((supported: boolean) => {
            if (alive && supported) setCoveredButDry(true)
        })
        return () => {
            alive = false
        }
    }, [domain])

    const noSite = !domain
    const heading = coveredButDry
        ? 'No working codes right now'
        : noSite
          ? 'Ready when you are'
          : 'No coupons for this site yet'
    const body = coveredButDry
        ? `We cover ${domain}, but none of our codes for it are working at the moment. We'll keep looking.`
        : noSite
          ? 'Caramel finds coupon codes and tries them for you at checkout. Open a store’s cart and we’ll take it from there.'
          : 'We’re adding new stores all the time — see the ones we support.'

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
                    <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />
                    <circle
                        cx="7.5"
                        cy="7.5"
                        r="1.3"
                        fill="#ea6925"
                        stroke="none"
                    />
                </svg>
            </div>

            <h3>{heading}</h3>
            <p>{body}</p>

            <AllSitesBanner api={api} />

            <div className="no-coupons-actions">
                {!coveredButDry && (
                    <a
                        href={caramelUrl('supported-stores')}
                        className="supported-sites-btn"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        View Supported Stores
                    </a>
                )}

                {user ? (
                    <button
                        type="button"
                        className="toggle-login-btn"
                        onClick={e =>
                            signOutAndRevoke(
                                () => setUser(null),
                                e.currentTarget,
                            )
                        }
                    >
                        Log out
                    </button>
                ) : (
                    <button
                        type="button"
                        // The id is a consumer contract, not styling:
                        // scripts/test-extension.mjs clicks #loginToggleBtn to
                        // reach the sign-in form, and this view is where a
                        // no-tab popup open lands (CI run 31659875787 failed
                        // on exactly this id going missing, 2026-08-13).
                        id="loginToggleBtn"
                        className="toggle-login-btn"
                        onClick={api.openSignIn}
                    >
                        Log in
                    </button>
                )}
            </div>

            <a
                className="oss-link"
                href="https://github.com/DevinoSolutions/caramel"
                target="_blank"
                rel="noopener noreferrer"
                title="All extension code is 100% open-source."
            >
                <svg
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    aria-hidden="true"
                >
                    <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.03.08-2.13 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.93.08 2.13.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
                </svg>
                <span>Open source</span>
            </a>
        </div>
    )
}
