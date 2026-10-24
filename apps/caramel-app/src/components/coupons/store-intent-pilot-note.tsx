import type {
    StoreFreshnessLine,
    StoreIntentPilotEntry,
} from '@/lib/seo/storeIntentPilot'

// T-7856 pilot (src/lib/seo/storeIntentPilot.ts): the note under a pilot store
// page's H1 + intro. Server-rendered, no client fetch, so it paints with the
// rest of the hero; it sits AFTER the h1 + p pair (first-paint-visible.spec.ts
// selects `main h1 + p`) and never moves them.
//
// The line is "<N> codes · list updated <when> · <k> worked in the last 7 days".
// It never says "verified": no per-code verification timestamp exists.
// TODO(T-7856): remove with the pilot, or fold into the hero for every store.
export default function StoreIntentPilotNote({
    line,
    confusedWith,
}: {
    line: StoreFreshnessLine
    confusedWith: StoreIntentPilotEntry['confusedWith']
}) {
    return (
        <div className="mt-4 space-y-2 text-sm text-gray-600 dark:text-gray-300">
            <p data-testid="store-freshness-line">
                {line.codes}
                {line.updated ? (
                    <>
                        {' · list updated '}
                        <time dateTime={line.updated.dateTime}>
                            {line.updated.label}
                        </time>
                    </>
                ) : null}
                {line.worked ? ` · ${line.worked}` : null}
            </p>
            {confusedWith ? (
                <p data-testid="store-confused-with">
                    {`Looking for ${confusedWith.name}? ${confusedWith.name} (${confusedWith.domain}) is a different site — see `}
                    <a
                        href={`/coupons/${encodeURIComponent(confusedWith.domain)}`}
                        className="font-medium text-caramel underline underline-offset-2"
                    >
                        {confusedWith.name} codes →
                    </a>
                </p>
            ) : null}
        </div>
    )
}
