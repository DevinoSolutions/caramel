'use client'

import { promptSupportOnFailure } from '@/lib/feedback/promptSupportOnFailure'
import { isValidUrl } from '@/lib/urlHelper'
import { motion } from 'framer-motion'
import { useState } from 'react'
import { toast } from 'sonner'

export default function SuggestionForm({
    initialValue,
    resetValue,
}: {
    initialValue: string
    resetValue: () => void
}) {
    const [url, setUrl] = useState(initialValue)
    const [loading, setLoading] = useState(false)

    const submit = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!url.trim()) return
        if (!isValidUrl(url)) {
            toast.warning('Please enter a valid URL.')
            return
        }
        setLoading(true)
        try {
            await fetch('/api/sites/suggest', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url }),
            })
            toast.success(`Thanks! We’ll look into supporting ${url} soon`)
        } catch (err) {
            toast.error('Failed to send suggestion. Please try again later.')
            console.error(err)
            // A blocked, user-visible action → offer the feedback prompt
            // (rate-limited to once per session by reportUserVisibleFailure).
            promptSupportOnFailure({
                error: err,
                operation: 'site_suggestion_submit',
            })
        }
        resetValue()
        setLoading(false)
    }

    return (
        <form
            onSubmit={submit}
            className="flex w-full flex-col items-center gap-6 rounded-3xl border border-caramel/20 bg-gradient-to-br from-caramel/5 via-orange-50/20 to-caramel/5 p-8 shadow-md dark:border-caramel/30 dark:from-caramel/10 dark:via-orange-900/10 dark:to-caramel/10 sm:p-6"
        >
            <p className="text-center leading-relaxed text-gray-700 dark:text-gray-300">
                We don’t support that store yet. Let us know and we’ll add it!
            </p>
            <input
                type="url"
                inputMode="url"
                value={url}
                onChange={e => setUrl(e.target.value)}
                placeholder="https://example.com"
                aria-label="Store URL"
                className="w-full rounded-full border-2 border-caramel/30 bg-white px-6 py-3 text-center placeholder-gray-400 shadow-sm outline-none transition-all focus:border-caramel dark:bg-darkSurface dark:text-white dark:placeholder-gray-500 dark:focus:border-orange-400"
            />
            <motion.button
                type="submit"
                disabled={loading}
                whileTap={{ scale: 0.95 }}
                className="max-w-full truncate rounded-full bg-gradient-to-r from-caramel to-orange-600 px-8 py-3 font-semibold text-white shadow transition-all hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-70 dark:focus-visible:ring-offset-darkBg"
            >
                {loading ? (
                    'Sending…'
                ) : (
                    <>
                        Request Support for{' '}
                        <span className="font-bold">{url}</span>
                    </>
                )}
            </motion.button>
        </form>
    )
}
