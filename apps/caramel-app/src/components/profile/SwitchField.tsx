'use client'

/**
 * A real switch — `<button role="switch">`, not a styled checkbox.
 *
 * Two deliberate behaviours:
 *
 * 1. NOT OPTIMISTIC. The knob does not move until the server confirms. A
 *    switch that flips instantly and then snaps back is a worse experience
 *    than a 300ms wait, because the user has already been told the setting
 *    changed. `busy` dims the knob to show work is happening.
 *
 * 2. The focus ring is INHERITED. globals.css styles
 *    `:where(a, button, [role='button'], summary):focus-visible` with a 2px
 *    caramel outline, and a `<button role="switch">` still matches `button` —
 *    so this component adds no ring of its own, on purpose. Adding one would
 *    render two competing rings.
 *
 * Hit area: the `-m-2 p-2` pair grows the target past the 44px minimum without
 * changing the switch's visual size or the row's layout.
 */
export default function SwitchField({
    id,
    checked,
    onChange,
    label,
    description,
    disabled,
    busy,
}: {
    id: string
    checked: boolean
    onChange: (next: boolean) => void
    label: string
    description?: string
    disabled?: boolean
    busy?: boolean
}) {
    return (
        <div className="flex items-start gap-3">
            <div className="min-w-0">
                <p
                    id={`${id}-label`}
                    className="text-sm font-semibold text-gray-900 dark:text-white"
                >
                    {label}
                </p>
                {description ? (
                    <p
                        id={`${id}-desc`}
                        className="mt-0.5 max-w-xs text-xs leading-relaxed text-gray-600 dark:text-gray-400"
                    >
                        {description}
                    </p>
                ) : null}
            </div>
            <button
                type="button"
                role="switch"
                id={id}
                aria-checked={checked}
                aria-labelledby={`${id}-label`}
                aria-describedby={description ? `${id}-desc` : undefined}
                disabled={disabled || busy}
                onClick={() => onChange(!checked)}
                className="-m-2 shrink-0 p-2 disabled:cursor-not-allowed disabled:opacity-70"
            >
                <span
                    aria-hidden="true"
                    className={`flex h-6 w-11 items-center rounded-full transition-colors duration-200 ${
                        checked ? 'bg-caramel' : 'bg-gray-300 dark:bg-gray-600'
                    }`}
                >
                    <span
                        className={`h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 motion-reduce:transition-none ${
                            checked ? 'translate-x-5' : 'translate-x-0.5'
                        } ${busy ? 'opacity-60' : ''}`}
                    />
                </span>
            </button>
        </div>
    )
}
