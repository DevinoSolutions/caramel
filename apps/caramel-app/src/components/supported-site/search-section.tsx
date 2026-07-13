'use client'

import Loader from '@/components/Loader'
import { AnimatePresence, motion } from 'framer-motion'
import debounce from 'lodash.debounce'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import SiteCard from './site-card'
import SuggestionForm from './suggestion-form'

export default function SearchSection() {
    const [query, setQuery] = useState('')
    const [sites, setSites] = useState([])
    const [topSites, setTopSites] = useState([])
    const [loading, setLoading] = useState(false)
    const [searched, setSearched] = useState(false)

    const loadTopSites = async () => {
        setLoading(true)
        setSearched(false)
        setSites([])
        try {
            const res = await fetch('/api/sites/top-sites')
            const data = await res.json()
            setTopSites(data.sites || [])
        } catch (err) {
            toast.error('Failed to load top sites.')
            console.error('Failed to load top sites:', err)
        }
        setLoading(false)
    }
    useEffect(() => {
        loadTopSites()
    }, [])
    const runSearch = async (q: string) => {
        setLoading(true)
        try {
            setSites([])
            const res = await fetch('/api/sites/search-supported', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: q }),
            })
            const data = await res.json()
            setSites(data.sites || [])
        } catch (err) {
            console.log('Failed to search sites, Try again.')
            console.error(err)
        }
        setLoading(false)
        setSearched(true)
    }

    const debouncedSearch = useRef(debounce(runSearch, 400)).current
    useEffect(() => () => debouncedSearch.cancel(), [debouncedSearch])

    useEffect(() => {
        if (!query.trim()) {
            setSites([])
            setSearched(false)
        } else {
            debouncedSearch(query)
        }
    }, [query, debouncedSearch])

    /* ui ------------------------------------------------------ */
    return (
        <>
            <section className="mx-auto w-full max-w-3xl px-4 sm:px-6">
                <motion.h1
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5 }}
                    className="mb-10 bg-gradient-to-r from-caramel to-orange-600 bg-clip-text text-center text-4xl font-extrabold text-transparent dark:from-orange-400 dark:to-caramel md:text-3xl"
                >
                    Is your favourite store supported?
                </motion.h1>

                <input
                    type="url"
                    inputMode="url"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    placeholder="https://example.com"
                    className="w-full rounded-full border-2 border-caramel/30 bg-white px-6 py-4 text-lg placeholder-gray-400 shadow-md outline-none transition-all focus:border-caramel dark:bg-gray-900 dark:text-white dark:placeholder-gray-500 dark:focus:border-orange-400 sm:text-base"
                />

                {/* loader */}
                <AnimatePresence>
                    {loading && (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            className="my-14 flex justify-center"
                        >
                            <Loader />
                        </motion.div>
                    )}
                </AnimatePresence>

                {/* results / top sites / suggestion */}
                {!loading && (
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.4 }}
                        className="mb-10 mt-12 space-y-6"
                    >
                        {sites.length ? (
                            <div className="grid grid-cols-2 gap-6 pb-10 md:grid-cols-1">
                                {sites.map(s => (
                                    <motion.div
                                        key={s}
                                        initial={{ opacity: 0, y: 20 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        transition={{
                                            duration: 0.3,
                                            delay: 0,
                                        }}
                                    >
                                        <SiteCard site={s} />
                                    </motion.div>
                                ))}
                            </div>
                        ) : (
                            <>
                                {searched && (
                                    <SuggestionForm
                                        resetValue={() => {
                                            setQuery('')
                                            setSites([])
                                            setSearched(false)
                                        }}
                                        initialValue={query}
                                    />
                                )}{' '}
                                {topSites.length > 0 && (
                                    <>
                                        <motion.h2
                                            initial={{ opacity: 0, y: 10 }}
                                            animate={{ opacity: 1, y: 0 }}
                                            transition={{ duration: 0.3 }}
                                            className="mb-10 border-b-[1px] pb-10 text-center text-2xl font-bold text-gray-800 dark:text-gray-200"
                                        >
                                            🏆 Top Supported Websites
                                        </motion.h2>
                                        <div className="grid grid-cols-2 gap-6 pb-10 md:grid-cols-1">
                                            {topSites.map(s => (
                                                <motion.div
                                                    key={s}
                                                    initial={{
                                                        opacity: 0,
                                                        y: 20,
                                                    }}
                                                    animate={{
                                                        opacity: 1,
                                                        y: 0,
                                                    }}
                                                    transition={{
                                                        duration: 0.3,
                                                        delay: 0,
                                                    }}
                                                >
                                                    <SiteCard site={s} />
                                                </motion.div>
                                            ))}
                                        </div>
                                    </>
                                )}
                            </>
                        )}
                    </motion.div>
                )}
            </section>
        </>
    )
}
