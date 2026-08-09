import { microLabelClasses } from '@/lib/profile/profileStyles'

/**
 * One impact number in the strip above the fold.
 *
 * `text-3xl` (30px) is load-bearing, not decoration: `text-caramel` measures
 * 3.19:1 on white, which is AA for large text ONLY (>=24px). Shrinking this
 * value's type size silently drops the tile below the contrast floor.
 *
 * A tile is only ever rendered for a real, non-zero number — the strip omits
 * itself entirely at zero rather than showing a wall of 0s (the checklist
 * takes its place).
 */
export default function StatTile({
    label,
    value,
    hint,
}: {
    label: string
    value: string
    hint?: string
}) {
    return (
        <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-darkerBg">
            <p className={microLabelClasses}>{label}</p>
            <p className="mt-1.5 text-3xl font-bold tracking-tight text-caramel">
                {value}
            </p>
            {hint ? (
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {hint}
                </p>
            ) : null}
        </div>
    )
}
