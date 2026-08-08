'use client'
import Doodles from '@/components/Doodles'
import { ThemeContext } from '@/lib/contexts'
import { decryptJsonData } from '@/lib/securityHelpers/decryptJsonData'
import type { SourceMetrics } from '@/lib/sourceMetrics'
import { motion } from 'framer-motion'
import { useContext, useState } from 'react'
import {
    Bar,
    CartesianGrid,
    ComposedChart,
    Legend,
    Line,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from 'recharts'
import { toast } from 'sonner'

// The row shape is the shared SourceMetrics from lib/sourceMetrics.ts — the
// ONE producer both the SSR page (initialSources prop) and the /api/sources
// refetch below go through, so the two can never drift.

export default function SourcesPageClient({
    initialSources,
}: {
    /** Server-rendered initial table (SEO) — same mapper as /api/sources. */
    initialSources: SourceMetrics[]
}) {
    const [sources, setSources] = useState<SourceMetrics[]>(initialSources)
    const [loading, setLoading] = useState(false)
    const [loadError, setLoadError] = useState(false)
    const [websitesInput, setWebsitesInput] = useState('')
    const [showModal, setShowModal] = useState(false)
    const [searchTerm, setSearchTerm] = useState('')
    const { isDarkMode } = useContext(ThemeContext)

    // No mount-time fetch anymore: the server component already rendered the
    // initial data into the HTML. This refetch runs only after submitting a
    // new source, to refresh the table through the API.
    const fetchSources = async () => {
        setLoading(true)
        setLoadError(false)
        try {
            const res = await fetch('/api/sources')
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const data = await res.json()
            const plainObj = await decryptJsonData<{ data?: SourceMetrics[] }>(
                data,
            )
            setSources(Array.isArray(plainObj?.data) ? plainObj.data : [])
        } catch (error) {
            console.error('Error fetching sources:', error)
            setLoadError(true)
            toast.error('Could not load sources')
        } finally {
            setLoading(false)
        }
    }

    const isValidUrl = (url: string): boolean => {
        try {
            new URL(url)
            return true
        } catch {
            return false
        }
    }

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!websitesInput) return
        if (!isValidUrl(websitesInput))
            return toast.error('Invalid URL. Please enter a valid URL.')

        try {
            const res = await fetch('/api/sources', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ website: websitesInput }),
            })
            if (res.ok) {
                toast.info('Source submission requested successfully!')
                setWebsitesInput('')
                setShowModal(false)
                fetchSources()
            } else {
                const { error } = await res.json()
                toast.error('Error: ' + (error || 'Something went wrong.'))
            }
        } catch (error) {
            console.error(error)
            toast.error('An error occurred while requesting a new source.')
        }
    }

    const filteredSources = sources.filter(
        src =>
            src.source.toLowerCase().includes(searchTerm.toLowerCase()) ||
            src.websites
                .join(' ')
                .toLowerCase()
                .includes(searchTerm.toLowerCase()),
    )

    const chartData = filteredSources.map(src => ({
        name: src.source,
        coupons: src.numberOfCoupons,
        successRate: src.successRate,
    }))

    return (
        <main className="relative min-h-screen overflow-x-clip bg-gray-50 p-6 text-gray-800 dark:bg-darkBg dark:text-gray-50">
            <Doodles />
            <motion.h1
                className="mb-4 text-center text-4xl font-bold text-caramel"
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
            >
                Sources
            </motion.h1>
            {showModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm">
                    <motion.div
                        role="dialog"
                        aria-modal="true"
                        aria-label="Submit a New Source"
                        className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-xl dark:border dark:border-caramel/30 dark:bg-darkSurface"
                        initial={{ opacity: 0, y: -20 }}
                        animate={{ opacity: 1, y: 0 }}
                    >
                        <button
                            type="button"
                            aria-label="Close"
                            className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel dark:hover:bg-darkBg dark:hover:text-gray-300"
                            onClick={() => setShowModal(false)}
                        >
                            X
                        </button>
                        <h2 className="mb-3 text-2xl font-semibold text-black dark:text-white">
                            Submit a New Source
                        </h2>
                        <p className="mb-4 text-sm text-gray-600 dark:text-gray-300">
                            Submit a new website or aggregator from which we can
                            get coupons! Help Caramel grow.
                        </p>
                        <form onSubmit={handleSubmit} className="space-y-4">
                            <div>
                                <label
                                    htmlFor="source-website-url"
                                    className="block text-sm font-medium text-black dark:text-white"
                                >
                                    Website URL
                                </label>
                                <input
                                    id="source-website-url"
                                    type="text"
                                    placeholder="https://"
                                    value={websitesInput}
                                    onChange={e =>
                                        setWebsitesInput(e.target.value)
                                    }
                                    className="mt-1 w-full rounded-lg border border-gray-300 p-2 text-black transition focus:border-caramel focus:outline-none focus:ring-2 focus:ring-caramel/40 dark:border-white/10 dark:bg-darkBg dark:text-white dark:placeholder-gray-500"
                                />
                            </div>
                            <div className="flex justify-end space-x-2">
                                <button
                                    type="button"
                                    className="transform rounded-lg bg-gray-500 px-4 py-2 text-white transition hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-darkSurface"
                                    onClick={() => setShowModal(false)}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    className="transform rounded-lg bg-caramel px-4 py-2 font-semibold text-white transition hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel focus-visible:ring-offset-2 dark:focus-visible:ring-offset-darkSurface"
                                >
                                    Submit
                                </button>
                            </div>
                        </form>
                    </motion.div>
                </div>
            )}
            <section className="mx-auto mt-8 max-w-6xl">
                <div className="mb-4 flex items-center justify-between">
                    <h2 className="text-2xl font-semibold text-black dark:text-white">
                        Caramel coupon sources
                    </h2>
                    <button
                        type="button"
                        onClick={() => setShowModal(true)}
                        className="transform rounded-lg bg-caramel px-4 py-2 font-semibold text-white shadow-md transition hover:scale-105 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel focus-visible:ring-offset-2 dark:focus-visible:ring-offset-darkBg"
                    >
                        Add New Source
                    </button>
                </div>
                <div className="mb-4">
                    <input
                        type="text"
                        placeholder="Search sources, websites..."
                        aria-label="Search sources"
                        value={searchTerm}
                        onChange={e => setSearchTerm(e.target.value)}
                        className="w-full rounded-lg border border-gray-300 bg-white p-2.5 text-black shadow-sm transition focus:border-caramel focus:outline-none focus:ring-2 focus:ring-caramel/40 dark:border-white/10 dark:bg-darkSurface dark:text-white dark:placeholder-gray-500"
                    />
                </div>
                <div className="grid grid-cols-1 gap-6">
                    <div className="overflow-x-auto rounded-xl border border-gray-100 bg-white p-6 shadow dark:border-caramel/30 dark:bg-darkSurface">
                        <table className="w-full text-left">
                            <thead>
                                <tr className="bg-gray-100 text-xs font-semibold uppercase tracking-wider text-gray-600 dark:bg-darkBg dark:text-gray-300">
                                    <th className="rounded-l-lg px-4 py-3">
                                        Source
                                    </th>
                                    <th className="px-4 py-3">Websites</th>
                                    <th className="px-4 py-3">Coupons</th>
                                    <th className="px-4 py-3">Success Rate</th>
                                    <th className="rounded-r-lg px-4 py-3">
                                        Status
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {loading ? (
                                    <tr>
                                        <td
                                            colSpan={5}
                                            className="py-10 text-center text-gray-500 dark:text-gray-300"
                                        >
                                            Loading...
                                        </td>
                                    </tr>
                                ) : loadError ? (
                                    <tr>
                                        <td
                                            colSpan={5}
                                            className="py-10 text-center text-gray-500 dark:text-gray-400"
                                        >
                                            Couldn&apos;t load sources.
                                        </td>
                                    </tr>
                                ) : filteredSources.length > 0 ? (
                                    filteredSources.map(src => (
                                        <tr
                                            key={src.id}
                                            className="border-b border-gray-100 transition-colors hover:bg-gray-50 dark:border-white/10 dark:hover:bg-darkBg/50"
                                        >
                                            <td className="px-4 py-3 font-medium">
                                                {src.source}
                                            </td>
                                            <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                                                {src.websites.join(', ')}
                                            </td>
                                            <td className="px-4 py-3 tabular-nums">
                                                {src.numberOfCoupons}
                                            </td>
                                            <td className="px-4 py-3 tabular-nums">
                                                {src.successRate}%
                                            </td>
                                            <td className="px-4 py-3">
                                                <div className="h-3 w-3 rounded-full bg-green-500 ring-4 ring-green-100 dark:ring-green-900/40"></div>
                                            </td>
                                        </tr>
                                    ))
                                ) : (
                                    <tr>
                                        <td
                                            colSpan={5}
                                            className="py-10 text-center text-gray-500 dark:text-gray-400"
                                        >
                                            No sources found.
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                    <div className="rounded-xl border border-gray-100 bg-white p-6 shadow dark:border-caramel/30 dark:bg-darkSurface">
                        <div className="h-96 w-full">
                            {loading ? (
                                <div className="flex h-full items-center justify-center text-gray-500">
                                    Loading graph...
                                </div>
                            ) : (
                                <ResponsiveContainer width="100%" height="100%">
                                    <ComposedChart data={chartData}>
                                        <CartesianGrid
                                            strokeDasharray="3 3"
                                            stroke={
                                                isDarkMode ? '#444' : '#ccc'
                                            }
                                        />
                                        <XAxis
                                            dataKey="name"
                                            tick={{
                                                fill: isDarkMode
                                                    ? '#fff'
                                                    : '#000',
                                            }}
                                            style={{ fontSize: '12px' }}
                                        />
                                        <YAxis
                                            yAxisId="left"
                                            tick={{
                                                fill: isDarkMode
                                                    ? '#fff'
                                                    : '#000',
                                            }}
                                            label={{
                                                value: 'Coupons',
                                                angle: -90,
                                                position: 'insideLeft',
                                                fill: isDarkMode
                                                    ? '#fff'
                                                    : '#000',
                                            }}
                                        />
                                        <YAxis
                                            yAxisId="right"
                                            orientation="right"
                                            tick={{
                                                fill: isDarkMode
                                                    ? '#fff'
                                                    : '#000',
                                            }}
                                            label={{
                                                value: 'Success Rate (%)',
                                                angle: 90,
                                                position: 'insideRight',
                                                fill: isDarkMode
                                                    ? '#fff'
                                                    : '#000',
                                            }}
                                        />
                                        <Tooltip
                                            contentStyle={{
                                                backgroundColor: isDarkMode
                                                    ? '#333'
                                                    : '#fff',
                                                borderColor: isDarkMode
                                                    ? '#444'
                                                    : '#ccc',
                                                color: isDarkMode
                                                    ? '#fff'
                                                    : '#000',
                                            }}
                                        />
                                        <Legend
                                            wrapperStyle={{
                                                color: isDarkMode
                                                    ? '#fff'
                                                    : '#000',
                                            }}
                                        />
                                        <Bar
                                            yAxisId="left"
                                            dataKey="coupons"
                                            fill="#ea6925"
                                        />
                                        <Line
                                            yAxisId="right"
                                            type="monotone"
                                            dataKey="successRate"
                                            stroke="#82ca9d"
                                        />
                                    </ComposedChart>
                                </ResponsiveContainer>
                            )}
                        </div>
                    </div>
                </div>
            </section>
        </main>
    )
}
