import { cardClasses } from '@/lib/profile/profileStyles'

/**
 * Loading placeholder shaped like the section it stands in for.
 *
 * Only the DATA-BACKED sections skeleton. The account header and Account
 * details render immediately from the session, which is already in memory — a
 * centered "Loading…" for the whole page (the old behaviour) is why this page
 * used to feel like a form rather than a home.
 *
 * `motion-reduce:animate-none` because `animate-pulse` is a Tailwind animation
 * and the app's global reduced-motion handling covers scrolling only.
 */
export default function SectionSkeleton() {
    return (
        <div
            role="status"
            aria-label="Loading your account"
            className={cardClasses}
        >
            <div className="h-4 w-24 animate-pulse rounded bg-gray-200 motion-reduce:animate-none dark:bg-gray-700" />
            <div className="mt-3 h-10 w-48 animate-pulse rounded bg-gray-200 motion-reduce:animate-none dark:bg-gray-700" />
            <div className="mt-6 space-y-4">
                {[0, 1, 2].map(i => (
                    <div key={i} className="flex items-center gap-4">
                        <div className="h-10 w-10 shrink-0 animate-pulse rounded-lg bg-gray-200 motion-reduce:animate-none dark:bg-gray-700" />
                        <div className="h-4 flex-1 animate-pulse rounded bg-gray-200 motion-reduce:animate-none dark:bg-gray-700" />
                    </div>
                ))}
            </div>
        </div>
    )
}
