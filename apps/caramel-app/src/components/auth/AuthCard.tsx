'use client'

import { motion } from 'framer-motion'

/**
 * The form column of an auth page.
 *
 * The heading is an <h1>. Every auth page previously opened at <h2> with no
 * <h1> anywhere in the document, which is both a heading-hierarchy failure for
 * screen readers and the single clearest on-page signal a crawler reads. The
 * old heading also inlined a 90px logo image mid-sentence ("Sign in to
 * [logo]"), so the accessible name depended on that image's alt text and the
 * line wrapped awkwardly at every width; the brand now lives in the panel
 * beside it, where it belongs.
 */
export default function AuthCard({
    title,
    subtitle,
    children,
    footer,
}: {
    title: string
    subtitle?: React.ReactNode
    children: React.ReactNode
    footer?: React.ReactNode
}) {
    return (
        <motion.div
            className="w-full min-w-0 max-w-[26rem]"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        >
            <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white sm:text-2xl">
                {title}
            </h1>
            {subtitle ? (
                <p className="mt-2 text-[15px] leading-relaxed text-gray-600 dark:text-gray-400">
                    {subtitle}
                </p>
            ) : null}
            <div className="mt-8 sm:mt-6">{children}</div>
            {footer ? <div className="mt-8 sm:mt-6">{footer}</div> : null}
        </motion.div>
    )
}

/** "or" rule between the social buttons and the email form. */
export function AuthDivider({ label = 'or' }: { label?: string }) {
    return (
        <div className="relative my-6">
            <div
                aria-hidden="true"
                className="absolute inset-0 flex items-center"
            >
                <div className="w-full border-t border-gray-200 dark:border-gray-800" />
            </div>
            <div className="relative flex justify-center">
                <span className="bg-white px-3 text-xs font-medium uppercase tracking-wider text-gray-500 dark:bg-darkBg dark:text-gray-400">
                    {label}
                </span>
            </div>
        </div>
    )
}
