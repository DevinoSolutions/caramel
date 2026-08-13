import { Button } from 'caramel-ui'

/**
 * Honest failure state for a dead coupons fetch (P2 React successor to
 * popup.js renderLoadError): backend down / offline must never leave the
 * popup blank. Retry re-runs the WHOLE init, exactly like the vanilla
 * retry button did. This is one of the two P2 surfaces that consciously
 * consume caramel-ui (the retry Button replaces `.supported-sites-btn`).
 */
export function LoadErrorView({ onRetry }: { onRetry: () => void }) {
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
                    <path d="M12 20h.01" />
                    <path d="M8.5 16.4a5 5 0 0 1 7 0" />
                    <path d="M5 12.9a10 10 0 0 1 14 0" />
                    <path d="M2 9.5a16 16 0 0 1 20 0" />
                    <path d="M2 2l20 20" />
                </svg>
            </div>
            <h3>Couldn&apos;t load coupons</h3>
            <p>Check your connection and try again.</p>
            <div className="no-coupons-actions">
                <Button variant="primary" onClick={onRetry}>
                    Try again
                </Button>
            </div>
        </div>
    )
}
