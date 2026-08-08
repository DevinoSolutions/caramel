'use client'

import { useReducedMotion } from '@/lib/reducedMotion'
import { motion } from 'framer-motion'

const dividerEase: [number, number, number, number] = [0.22, 1, 0.36, 1]

interface SectionDividerProps {
    // Full Tailwind gradient class strings, passed as literals from the page so
    // the JIT scanner still sees every colour used. Since the tear line itself
    // is now a fixed caramel dashed border, these two drive the SOFT layers
    // under it — the per-divider colour the page varies stays visible as the
    // warm haze that fades out toward each end.
    lineClassName: string
    glowClassName: string
}

// The perforated tear line that wipes in between landing sections: the same
// coupon-ticket motif as the pricing card, so the landing page and /pricing
// speak one visual language. Bounded to the sections' own max-w-7xl content
// column (it used to run full-bleed and fade at the viewport edges) so the
// dashes have two definite ends for the punch-hole notches to sit on.
//
// Extracted from app/page.tsx so that page can be a server component:
// framer-motion's useReducedMotion is client-only, and the dividers were the
// only thing forcing 'use client' on the whole route once useSearchParams
// moved out.
export default function SectionDivider({
    lineClassName,
    glowClassName,
}: SectionDividerProps): React.JSX.Element {
    const reduceMotion = useReducedMotion()

    return (
        <div
            aria-hidden="true"
            className="mx-auto w-full max-w-7xl px-6 lg:px-8"
        >
            <div className="relative h-0.5">
                {/* The line wipes; the notches must NOT, or scaleX would
                    squash them into ellipses for the length of the wipe. */}
                <motion.div
                    className="absolute inset-0"
                    initial={reduceMotion ? false : { scaleX: 0 }}
                    whileInView={{ scaleX: 1 }}
                    viewport={{ once: true, margin: '0px 0px -40px 0px' }}
                    transition={{ duration: 1.4, ease: dividerEase }}
                >
                    <div
                        className={`absolute inset-x-0 top-0 h-px blur-[1px] ${lineClassName}`}
                    ></div>
                    <div
                        className={`absolute inset-x-0 top-0 h-px ${glowClassName}`}
                    ></div>
                    <div className="absolute inset-x-0 top-0 border-t-2 border-dashed border-caramel/25 dark:border-caramel/35"></div>
                </motion.div>

                {/* Punch holes at each end of the perforation. Filled with the
                    page background (globals.css body = gray-50 / darkBg) so the
                    dashes are genuinely interrupted rather than overlaid, with a
                    caramel ring to read as a hole on a matching backdrop.

                    The -translate centering MUST stay on these plain spans:
                    framer writes inline `transform` on a motion element and
                    resets it to `none` at rest, which beats Tailwind's
                    transform-shorthand classes. Here that would not merely kill
                    a hover — the translate is load-bearing positioning, so both
                    holes would jump half their size off the line. The motion
                    child therefore carries the fade and nothing else. */}
                <span className="absolute left-0 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2">
                    <motion.span
                        className="block h-full w-full rounded-full bg-gray-50 ring-1 ring-caramel/25 dark:bg-darkBg dark:ring-caramel/35"
                        initial={reduceMotion ? false : { opacity: 0 }}
                        whileInView={{ opacity: 1 }}
                        viewport={{ once: true, margin: '0px 0px -40px 0px' }}
                        transition={{
                            duration: 0.5,
                            delay: 0.9,
                            ease: dividerEase,
                        }}
                    ></motion.span>
                </span>
                <span className="absolute right-0 top-1/2 h-3 w-3 -translate-y-1/2 translate-x-1/2">
                    <motion.span
                        className="block h-full w-full rounded-full bg-gray-50 ring-1 ring-caramel/25 dark:bg-darkBg dark:ring-caramel/35"
                        initial={reduceMotion ? false : { opacity: 0 }}
                        whileInView={{ opacity: 1 }}
                        viewport={{ once: true, margin: '0px 0px -40px 0px' }}
                        transition={{
                            duration: 0.5,
                            delay: 0.9,
                            ease: dividerEase,
                        }}
                    ></motion.span>
                </span>
            </div>
        </div>
    )
}
