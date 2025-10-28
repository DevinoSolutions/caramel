'use client'
import Doodles from '@/components/Doodles'
import { ThemeContext } from '@/lib/contexts'
import { decryptJsonData } from '@/lib/securityHelpers/decryptJsonData'
import { motion } from 'framer-motion'
import { useContext, useEffect, useState } from 'react'
import { toast } from 'react-toastify'
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

interface Source {
    id: string
    source: string
    websites: string[]
    numberOfCoupons: string
    successRate: string
}

export default function SourcesPage() {
    const [sources, setSources] = useState<Source[]>([])
    const [loading, setLoading] = useState(true)
    const [websitesInput, setWebsitesInput] = useState('')
    const [showModal, setShowModal] = useState(false)
    const [searchTerm, setSearchTerm] = useState('')
    const { isDarkMode } = useContext(ThemeContext)

    const fetchSources = async () => {
        setLoading(true)
        try {
            const res = await fetch('/api/sources')
            const data = await res.json()
            const plainObj = await decryptJsonData(data)
            setSources(plainObj.data)
        } catch (error) {
            console.error('Error fetching sources:', error)
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        fetchSources()
    }, [])

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
        coupons: parseInt(src.numberOfCoupons as any, 10),
        successRate: parseFloat(src.successRate as any),
    }))

    return (
        <main className="relative min-h-screen overflow-x-clip bg-gray-50 p-6 text-gray-800 dark:bg-transparent dark:text-gray-50">
            <Doodles />
            <motion.h1
                className="text-caramel mb-4 text-center text-4xl font-bold"
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
            >
                Sources
            </motion.h1>
            {showModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-60">
                    <motion.div
                        className="dark:bg-darkerBg relative w-1/3 rounded-lg bg-white p-6 shadow md:w-11/12"
                        initial={{ opacity: 0, y: -20 }}
                        animate={{ opacity: 1, y: 0 }}
                    >
                        <button
                            className="absolute right-2 top-2 text-gray-500 hover:text-gray-700"
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
                                <label className="block text-sm font-medium text-black dark:text-white">
                                    Website URL
                                </label>
                                <input
                                    type="text"
                                    placeholder="https://"
                                    value={websitesInput}
                                    onChange={e =>
                                        setWebsitesInput(e.target.value)
                                    }
                                    className="focus:ring-caramel mt-1 w-full rounded border border-gray-300 p-2 text-black focus:outline-none focus:ring-2"
                                />
                            </div>
                            <div className="flex justify-end space-x-2">
                                <button
                                    type="button"
                                    className="transform rounded bg-gray-500 px-4 py-2 text-white transition hover:scale-105"
                                    onClick={() => setShowModal(false)}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    className="bg-caramel transform rounded px-4 py-2 font-semibold text-white transition hover:scale-105"
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
                        onClick={() => setShowModal(true)}
                        className="bg-caramel transform rounded px-4 py-2 font-semibold text-white transition hover:scale-105"
                    >
                        Add New Source
                    </button>
                </div>
                <div className="mb-4">
                    <input
                        type="text"
                        placeholder="Search sources, websites..."
                        value={searchTerm}
                        onChange={e => setSearchTerm(e.target.value)}
                        className="focus:ring-caramel w-full rounded border border-gray-300 p-2 text-black focus:outline-none focus:ring-2"
                    />
                </div>
                <div className="grid grid-cols-1 gap-6">
                    <div className="dark:bg-darkerBg overflow-x-auto rounded-lg bg-white p-6 shadow">
                        <table className="w-full text-left">
                            <thead>
                                <tr className="dark:bg-darkBg bg-gray-100 text-black dark:text-white">
                                    <th className="px-4 py-2">Source</th>
                                    <th className="px-4 py-2">Websites</th>
                                    <th className="px-4 py-2">Coupons</th>
                                    <th className="px-4 py-2">Success Rate</th>
                                    <th className="px-4 py-2">Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                {loading ? (
                                    <tr>
                                        <td
                                            colSpan={5}
                                            className="py-4 text-center text-gray-500 dark:text-gray-300"
                                        >
                                            Loading...
                                        </td>
                                    </tr>
                                ) : filteredSources.length > 0 ? (
                                    filteredSources.map(src => (
                                        <tr
                                            key={src.id}
                                            className="dark:hover:bg-darkBg/50 border-b hover:bg-gray-50"
                                        >
                                            <td className="px-4 py-2">
                                                {src.source}
                                            </td>
                                            <td className="px-4 py-2">
                                                {src.websites.join(', ')}
                                            </td>
                                            <td className="px-4 py-2">
                                                {parseInt(
                                                    src.numberOfCoupons as any,
                                                    10,
                                                )}
                                            </td>
                                            <td className="px-4 py-2">
                                                {src.successRate}%
                                            </td>
                                            <td className="px-4 py-2">
                                                <div className="h-5 w-5 rounded-full bg-green-500"></div>
                                            </td>
                                        </tr>
                                    ))
                                ) : (
                                    <tr>
                                        <td
                                            colSpan={5}
                                            className="py-4 text-center text-gray-500"
                                        >
                                            No sources found.
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                    <div className="dark:bg-darkerBg rounded-lg bg-white p-6 shadow">
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
