import { useEffect, useState } from 'react'
import { caramelGetSavings } from '../../../caramel-base.js'
import { formatSavingsTotal } from '../../../popup-core.js'

/**
 * Lifetime-savings banner (P2 React successor to popup.js
 * renderSavingsSummary): totals the measured-wins history per currency and
 * renders only when there is anything to show. The #savingsSummary wrapper
 * stays — styles.css and the view layouts key on it.
 */
export function SavingsBanner() {
    const [total, setTotal] = useState('')

    useEffect(() => {
        let alive = true
        caramelGetSavings().then((list: unknown[]) => {
            if (alive) setTotal(formatSavingsTotal(list))
        })
        return () => {
            alive = false
        }
    }, [])

    return (
        <div id="savingsSummary">
            {total ? (
                <div className="savings-banner">
                    <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                    >
                        <path d="M12 2v20" />
                        <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                    </svg>
                    <span>
                        You&apos;ve saved <b>{total}</b> with Caramel
                    </span>
                </div>
            ) : null}
        </div>
    )
}
