'use client'

import Loader from '@/components/Loader'
import type { Coupon, CouponFilters } from '@/types/coupon'
import { AnimatePresence, motion } from 'framer-motion'
import Image from 'next/image'
import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import InfiniteScroll from 'react-infinite-scroll-component'
import { toast } from 'sonner'
import CouponCard from './coupon-card'
import CouponFiltersComponent from './coupon-filters'
// Tabs temporarily hidden until backed by data
// import CouponTabs from './coupon-tabs'

interface CouponsSectionProps {
    defaultFilters?: Partial<CouponFilters>
    initialCoupons?: Coupon[]
    initialTotal?: number
    disableInitialFetch?: boolean
    heroTitle?: string
    heroSubtitle?: string
}

const ITEMS_PER_PAGE = 5

export default function CouponsSection({
    defaultFilters,
    initialCoupons,
    initialTotal,
    disableInitialFetch = false,
    heroTitle = 'All Coupons',
    heroSubtitle = 'Browse verified coupon codes, promo codes, and offers.',
}: CouponsSectionProps) {
    const MIN_LOADING_DELAY_MS = 350

    const initialFiltersState: CouponFilters = {
        search: '',
        site: '',
        type: 'all',
        ...defaultFilters,
    }

    const hasPrefetched = Array.isArray(initialCoupons)
    const initialHasMore =
        hasPrefetched && typeof initialTotal === 'number'
            ? (initialCoupons?.length || 0) < initialTotal
            : hasPrefetched
              ? (initialCoupons?.length || 0) >= ITEMS_PER_PAGE
              : true

    const [coupons, setCoupons] = useState<Coupon[]>(initialCoupons || [])
    const [loading, setLoading] = useState(!hasPrefetched)
    const [hasMore, setHasMore] = useState(initialHasMore)
    const [page, setPage] = useState(1)
    const [isLoadingMore, setIsLoadingMore] = useState(false)
    const [filters, setFilters] = useState<CouponFilters>(initialFiltersState)
    const [storeOptions, setStoreOptions] = useState<string[]>([])
    const [discountOptions, setDiscountOptions] = useState<string[]>([])
    const couponsLengthRef = useRef(initialCoupons?.length || 0)
    const initialFetchDone = useRef(disableInitialFetch)
    const sentinelRef = useRef<HTMLDivElement | null>(null)

    const storeDomain = (defaultFilters?.site || filters.site || '').trim()
    const storeLogo = storeDomain
        ? `https://www.google.com/s2/favicons?sz=128&domain_url=${encodeURIComponent(
              storeDomain,
          )}`
        : '/full-logo.png'
    const sidebarTitle = storeDomain || 'Caramel'
    const sidebarDescription = storeDomain
        ? `Save at ${storeDomain} with verified coupon codes. Caramel applies the best deals automatically at checkout.`
        : "The open-source and privacy-first alternative to Honey. Automatically finds and applies the best coupon codes at checkout — without selling your data or hijacking creators' commissions."

    useEffect(() => {
        couponsLengthRef.current = coupons.length
    }, [coupons.length])

    // Prefetch filter metadata (stores and discount types)
    useEffect(() => {
        const loadFiltersMeta = async () => {
            try {
                const res = await fetch(
                    '/api/coupons/filters?includeSites=false',
                )
                if (!res.ok) throw new Error('Failed to load filter options')
                const data = await res.json()
                if (Array.isArray(data.discountTypes)) {
                    setDiscountOptions(data.discountTypes)
                }
            } catch (err) {
                console.error('Failed to load filter metadata:', err)
            }
        }
        loadFiltersMeta()
    }, [])

    const fetchCoupons = useCallback(
        async (pageNum: number, reset = false) => {
            const startedAt = Date.now()
            if (reset) {
                setLoading(true)
            }

            try {
                const params = new URLSearchParams({
                    page: pageNum.toString(),
                    limit: ITEMS_PER_PAGE.toString(),
                })

                if (filters.search.trim()) {
                    params.set('search', filters.search.trim())
                }
                if (filters.site.trim()) {
                    params.set('site', filters.site.trim())
                }
                if (filters.type !== 'all') {
                    params.set('type', filters.type)
                }

                const res = await fetch(`/api/coupons?${params}`)
                if (!res.ok) {
                    throw new Error(`Request failed with status ${res.status}`)
                }

                const data = await res.json()
                const incomingCoupons: Coupon[] = data.coupons || []
                const hasMoreFromApi =
                    typeof data.hasMore === 'boolean' ? data.hasMore : undefined
                const totalFromApi =
                    typeof data.total === 'number' ? data.total : undefined
                const previousCount = couponsLengthRef.current

                const nextHasMore =
                    hasMoreFromApi ??
                    (typeof totalFromApi === 'number'
                        ? pageNum * ITEMS_PER_PAGE < totalFromApi
                        : incomingCoupons.length === ITEMS_PER_PAGE)
                const nextCount = reset
                    ? incomingCoupons.length
                    : incomingCoupons.length + previousCount

                if (incomingCoupons.length > 0) {
                    setCoupons(prev =>
                        reset ? incomingCoupons : [...prev, ...incomingCoupons],
                    )
                    couponsLengthRef.current = nextCount
                    setHasMore(nextHasMore)
                } else {
                    setHasMore(false)
                    if (reset) {
                        couponsLengthRef.current = 0
                    }
                }
            } catch (err) {
                toast.error('Failed to load coupons')
                console.error('Failed to load coupons:', err)
                setHasMore(false)
            } finally {
                const wrapUp = () => {
                    setIsLoadingMore(false)
                    if (reset) {
                        setLoading(false)
                    }
                }
                const elapsed = Date.now() - startedAt
                const remaining =
                    !reset && elapsed < MIN_LOADING_DELAY_MS
                        ? MIN_LOADING_DELAY_MS - elapsed
                        : 0
                if (remaining > 0) {
                    setTimeout(wrapUp, remaining)
                } else {
                    wrapUp()
                }
            }
        },
        [filters],
    )

    // Trigger fetch when filters change
    useEffect(() => {
        if (!initialFetchDone.current) return
        setPage(1)
        setCoupons([])
        setHasMore(true)
        setLoading(true)
        fetchCoupons(1, true)
    }, [filters, fetchCoupons])

    // Initial fetch (guarded to avoid React StrictMode double-invoke)
    useEffect(() => {
        if (initialFetchDone.current) return
        initialFetchDone.current = true
        setLoading(true)
        setPage(1)
        setCoupons([])
        setHasMore(true)
        fetchCoupons(1, true)
    }, [fetchCoupons])

    const loadMore = useCallback(() => {
        if (!hasMore || isLoadingMore || loading) {
            return
        }

        const nextPage = page + 1
        setIsLoadingMore(true)
        setPage(nextPage)

        fetchCoupons(nextPage, false)
    }, [fetchCoupons, hasMore, isLoadingMore, loading, page])

    const handleNext = useCallback(() => {
        loadMore()
    }, [hasMore, isLoadingMore, loading, loadMore, page])

    const handleFilterChange = (newFilters: Partial<CouponFilters>) => {
        setFilters(prev => ({ ...prev, ...newFilters }))
        setPage(1)
        setCoupons([])
        setHasMore(true)
    }

    // IntersectionObserver fallback to trigger loadMore when the sentinel hits the viewport
    useEffect(() => {
        const target = sentinelRef.current
        if (!target) return

        const observer = new IntersectionObserver(
            entries => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        loadMore()
                    }
                })
            },
            { rootMargin: '200px 0px' },
        )

        observer.observe(target)
        return () => observer.disconnect()
    }, [loadMore])

    return (
        <div className="mx-auto w-full max-w-7xl">
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5 }}
                className="mb-8 text-center"
            >
                <h1 className="from-caramel dark:to-caramel mb-4 bg-gradient-to-r to-orange-600 bg-clip-text text-5xl font-extrabold text-transparent sm:text-3xl md:text-4xl dark:from-orange-400">
                    {heroTitle}
                </h1>
                {heroSubtitle ? (
                    <p className="mx-auto max-w-2xl text-gray-600 dark:text-gray-300">
                        {heroSubtitle}
                    </p>
                ) : null}
            </motion.div>

            <div className="flex gap-8 md:flex-col">
                {/* Main Content */}
                <div className="flex-1">
                    {/* Tabs removed until we have distinct categories backed by data */}

                    <CouponFiltersComponent
                        filters={filters}
                        onChange={handleFilterChange}
                        storeOptions={storeOptions}
                        discountOptions={discountOptions}
                        onClearAll={() => {
                            // If a store filter is set via defaultFilters (store page), clearing should send back to all coupons
                            if (defaultFilters?.site) {
                                window.location.href = '/coupons'
                            }
                        }}
                    />

                    {loading && coupons.length === 0 ? (
                        <div className="flex min-h-[400px] items-center justify-center">
                            <Loader label="Loading coupons..." />
                        </div>
                    ) : coupons.length === 0 ? (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            className="flex min-h-[400px] flex-col items-center justify-center rounded-3xl bg-white p-12 shadow-lg dark:bg-gray-900"
                        >
                            <p className="from-caramel mb-4 bg-gradient-to-r to-orange-600 bg-clip-text text-4xl font-bold text-transparent">
                                No coupons found
                            </p>
                            <p className="text-gray-600 dark:text-gray-400">
                                Try adjusting your filters
                            </p>
                        </motion.div>
                    ) : (
                        <InfiniteScroll
                            key={JSON.stringify(filters)}
                            dataLength={coupons.length}
                            next={handleNext}
                            hasMore={hasMore}
                            style={{ overflow: 'visible' }}
                            scrollThreshold={0.95}
                            loader={
                                <div className="flex justify-center py-8">
                                    <Loader label="Loading more coupons..." />
                                </div>
                            }
                            endMessage={
                                <motion.div
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    className="from-caramel mt-8 rounded-3xl bg-gradient-to-r to-orange-600 p-8 text-center text-white shadow-xl"
                                >
                                    <p className="text-lg font-semibold">
                                        You&apos;ve seen all available coupons.
                                    </p>
                                    <p className="mt-2 text-sm opacity-90">
                                        Check back soon for more deals
                                    </p>
                                </motion.div>
                            }
                        >
                            <div className="space-y-4 pb-12">
                                <AnimatePresence mode="popLayout">
                                    {coupons.map((coupon, index) => (
                                        <CouponCard
                                            key={`${coupon.id}-${index}`}
                                            coupon={coupon}
                                            index={index}
                                        />
                                    ))}
                                </AnimatePresence>
                            </div>
                            {isLoadingMore && hasMore ? (
                                <div className="flex justify-center py-6">
                                    <Loader label="Loading more coupons..." />
                                </div>
                            ) : null}
                            <div ref={sentinelRef} className="h-px w-full" />
                        </InfiniteScroll>
                    )}
                </div>

                {/* Sidebar */}
                <aside className="w-80 space-y-4 md:w-full">
                    <div className="rounded-2xl bg-white p-6 shadow-lg dark:bg-gray-900">
                        <div className="mb-4 flex items-center justify-center">
                            <Image
                                src={storeLogo}
                                alt={`${sidebarTitle} logo`}
                                width={storeDomain ? 56 : 200}
                                height={storeDomain ? 56 : 80}
                                className={
                                    storeDomain
                                        ? 'h-14 w-14 rounded-md'
                                        : 'h-auto w-auto max-w-[180px]'
                                }
                                priority
                            />
                        </div>
                        {storeDomain ? (
                            <p className="text-center text-sm font-semibold text-gray-800 dark:text-gray-100">
                                {sidebarTitle}
                            </p>
                        ) : null}
                        <p className="mt-2 text-center text-sm text-gray-600 dark:text-gray-300">
                            {sidebarDescription}
                        </p>
                    </div>

                    <div className="rounded-2xl bg-white p-6 shadow-lg dark:bg-gray-900">
                        <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">
                            Available on Your Favorite Browser
                        </p>
                        <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                            Start saving with Caramel on any browser!
                        </p>
                        <div className="mt-3 grid grid-cols-2 gap-2 text-sm font-medium text-gray-800 dark:text-gray-100">
                            {['Chrome', 'Safari', 'Firefox', 'Edge'].map(
                                browser => (
                                    <span
                                        key={browser}
                                        className="rounded-xl bg-gray-50 px-3 py-2 text-center shadow-sm dark:bg-gray-800"
                                    >
                                        {browser}
                                    </span>
                                ),
                            )}
                        </div>
                    </div>

                    <div className="rounded-2xl bg-white p-6 shadow-lg dark:bg-gray-900">
                        <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">
                            5,000+ Supported Stores
                        </p>
                        <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                            From major retailers to niche marketplaces, Caramel
                            works everywhere you shop online.
                        </p>
                        <Link
                            href="/supported-sites"
                            className="from-caramel mt-4 inline-flex items-center justify-center rounded-full bg-gradient-to-r to-orange-600 px-4 py-2 text-xs font-semibold text-white shadow-md transition hover:opacity-90"
                        >
                            View All Supported Sites
                        </Link>
                    </div>
                </aside>
            </div>
        </div>
    )
}
