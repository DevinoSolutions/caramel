import { useEffect, useState } from 'react'
import {
    caramelGetUsageDiagnosticsConsent,
    caramelRequestUsageDiagnosticsPermission,
    caramelSetUsageDiagnosticsConsent,
    logError,
} from '../../../caramel-base.js'
import { useToast } from './toast'

/**
 * The one-time ask behind anonymous usage diagnostics (see
 * usage-diagnostics-consent.js). Shown while the shopper has not answered —
 * no record, or one for an older prompt version — and gone for good once they
 * press either button; Settings has the toggle to change the answer later.
 * Off by default: nothing is sent unless "Allow" is pressed.
 *
 * "Allow" asks the browser for its own data-collection grant FIRST (Firefox
 * only; a no-op elsewhere) and records the consent only if that was granted:
 * a refused browser prompt records nothing. The request has to leave straight
 * out of the click, so there is no await before it. If Firefox tears the popup
 * down while its prompt is open this continuation is lost and the card simply
 * asks again on the next open (the grant is then already held, so "Allow"
 * records at once).
 */
export function UsageDiagnosticsCard() {
    const showToast = useToast()
    const [unanswered, setUnanswered] = useState(false)
    const [busy, setBusy] = useState(false)

    useEffect(() => {
        let alive = true
        // A record that cannot be read shows no card: asking a question whose
        // answer could not be stored reliably is worse than not asking.
        caramelGetUsageDiagnosticsConsent().then(
            (record: unknown) => {
                if (alive) setUnanswered(record === null)
            },
            (err: unknown) =>
                logError('popup: usage-diagnostics consent read', err),
        )
        return () => {
            alive = false
        }
    }, [])

    if (!unanswered) return null

    const allow = () => {
        setBusy(true)
        caramelRequestUsageDiagnosticsPermission()
            .then(async (granted: boolean) => {
                if (!granted) {
                    showToast(
                        'Your browser did not allow it, so nothing was turned on.',
                    )
                    return
                }
                await caramelSetUsageDiagnosticsConsent('accepted')
                setUnanswered(false)
            })
            .catch((err: unknown) => {
                logError('popup: usage-diagnostics allow', err)
                showToast('Couldn’t change that setting. Please try again.')
            })
            .finally(() => setBusy(false))
    }

    const decline = () => {
        setBusy(true)
        caramelSetUsageDiagnosticsConsent('declined')
            .then(() => setUnanswered(false))
            .catch((err: unknown) => {
                logError('popup: usage-diagnostics decline', err)
                showToast('Couldn’t change that setting. Please try again.')
            })
            .finally(() => setBusy(false))
    }

    return (
        <section
            className="diagnostics-card"
            id="usageDiagnosticsCard"
            aria-labelledby="usageDiagnosticsTitle"
        >
            <h3 id="usageDiagnosticsTitle">Help improve Caramel?</h3>
            <p>
                Send anonymous usage diagnostics, such as whether the
                code-sharing offer appeared on a supported store and why a code
                wasn&apos;t shared. Never your codes, your browsing history, or
                anything that identifies you. You can change this anytime in
                Settings.
            </p>
            <div className="diagnostics-card-actions">
                <button
                    type="button"
                    id="usageDiagnosticsAllow"
                    className="diagnostics-card-btn"
                    disabled={busy}
                    onClick={allow}
                >
                    Allow
                </button>
                <button
                    type="button"
                    id="usageDiagnosticsDecline"
                    className="diagnostics-card-btn"
                    disabled={busy}
                    onClick={decline}
                >
                    No thanks
                </button>
            </div>
        </section>
    )
}
