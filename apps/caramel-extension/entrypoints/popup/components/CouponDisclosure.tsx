import { useId, useState, type ReactNode } from 'react'

/**
 * A collapsed section at the foot of the coupon list ("N codes reported not
 * working", "Hidden codes (N)"). A real button with aria-expanded owns the
 * toggle; the body is not rendered while closed, so collapsed codes cost the
 * list no height and no tab stops.
 */
export function CouponDisclosure({
    id,
    label,
    children,
}: {
    id: string
    label: string
    children: ReactNode
}) {
    const [open, setOpen] = useState(false)
    const bodyId = useId()
    return (
        <div id={id} className="coupon-disclosure">
            <button
                type="button"
                className="coupon-disclosure-toggle"
                aria-expanded={open}
                aria-controls={bodyId}
                onClick={() => setOpen(o => !o)}
            >
                {label}
            </button>
            <div id={bodyId} hidden={!open}>
                {open && children}
            </div>
        </div>
    )
}
