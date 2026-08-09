'use client'

import Loader from '@/components/Loader'
import { promptSupportOnFailure } from '@/lib/feedback/promptSupportOnFailure'
import type { Coupon, CouponFilters } from '@/types/coupon'
import { MagnifyingGlassIcon } from '@heroicons/react/24/outline'
import { AnimatePresence, motion } from 'framer-motion'
import Image from 'next/image'
import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { FaChrome, FaEdge, FaFirefox, FaSafari } from 'react-icons/fa'
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
    /** Optional control rendered under the hero subtitle — the store page's
     * "follow this store" star. A SLOT rather than a prop the section knows
     * about, so this shared component stays ignorant of accounts and favorites.
     *
     * Omitting it renders NOTHING extra: /coupons (a visual-regression
     * baseline) passes no slot and its DOM is byte-identical to before. Only
     * /coupons/[store], which has no baseline, fills it. */
    heroAction?: React.ReactNode
}

const ITEMS_PER_PAGE = 5

export default function CouponsSection({
    defaultFilters,
    initialCoupons,
    initialTotal,
    disableInitialFetch = false,
    heroTitle = 'All Coupons',
    heroSubtitle = 'Browse verified coupon codes, promo codes, and offers.',
    heroAction,
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
    const lastFetchedFiltersRef = useRef(JSON.stringify(initialFiltersState))
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
                    '/api/coupons/filters?includeSites=true',
                )
                if (!res.ok) throw new Error('Failed to load filter options')
                const data = await res.json()
                if (Array.isArray(data.sites)) {
                    setStoreOptions(data.sites)
                }
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
                // A blocked, user-visible action → offer the feedback prompt
                // (Sentry + PostHog once per session; rate-limited internally).
                promptSupportOnFailure({
                    error: err,
                    operation: 'coupons_fetch',
                })
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

    // Trigger fetch when filters change. Keyed on the last-FETCHED filter
    // values, not effect timing: on an SSR page (disableInitialFetch +
    // initialCoupons) this effect used to refire on hydration mount and wipe
    // the server-rendered list with a loader + duplicate /api/coupons fetch.
    // The ref starts at the initial filter state — already satisfied by the
    // server render (or by the initial-fetch effect below) — so the effect
    // fetches exactly when the filters differ from what's on screen, and a
    // StrictMode double-invoke sees the ref already updated and no-ops.
    useEffect(() => {
        const filtersJson = JSON.stringify(filters)
        if (filtersJson === lastFetchedFiltersRef.current) return
        lastFetchedFiltersRef.current = filtersJson
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

    // List reset + refetch live in the filter effect above (keyed on the
    // last-fetched values) — clearing here too would blank the list even when
    // a re-selected value changes nothing.
    const handleFilterChange = (newFilters: Partial<CouponFilters>) => {
        setFilters(prev => ({ ...prev, ...newFilters }))
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
                <h1 className="mb-4 bg-gradient-to-r from-caramel to-orange-600 bg-clip-text text-5xl font-extrabold text-transparent dark:from-orange-400 dark:to-caramel md:text-4xl sm:text-3xl">
                    {heroTitle}
                </h1>
                {heroSubtitle ? (
                    <p className="mx-auto max-w-2xl text-gray-600 dark:text-gray-300">
                        {heroSubtitle}
                    </p>
                ) : null}
                {heroAction ?? null}
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
                            className="flex min-h-[400px] flex-col items-center justify-center rounded-3xl border-2 border-dashed border-caramel/25 bg-white p-12 text-center shadow-sm dark:border-caramel/30 dark:bg-darkSurface"
                        >
                            <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-caramel/10 text-3xl dark:bg-caramel/20">
                                <MagnifyingGlassIcon className="h-8 w-8 text-caramel" />
                            </div>
                            <p className="mb-2 bg-gradient-to-r from-caramel to-orange-600 bg-clip-text text-3xl font-bold text-transparent sm:text-2xl">
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
                                    className="mt-8 rounded-3xl bg-gradient-to-r from-caramel to-orange-600 p-8 text-center text-white shadow-xl"
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
                    <div className="rounded-2xl border border-gray-100 bg-white p-6 shadow-lg dark:border-white/10 dark:bg-darkSurface">
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

                    <div className="rounded-2xl border border-gray-100 bg-white p-6 shadow-lg dark:border-white/10 dark:bg-darkSurface">
                        <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">
                            Available on Your Favorite Browser
                        </p>
                        <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                            Start saving with Caramel on any browser!
                        </p>
                        <div className="mt-3 grid grid-cols-2 gap-2 text-sm font-medium text-gray-800 dark:text-gray-100">
                            {[
                                {
                                    name: 'Chrome',
                                    icon: <FaChrome />,
                                    href: 'https://chromewebstore.google.com/detail/caramel-trusted-honey-alt/gaimofgglbackoimfjopicmbmnlccfoe',
                                    available: true,
                                },
                                {
                                    name: 'Safari',
                                    icon: <FaSafari />,
                                    href: 'https://apps.apple.com/ke/app/caramel/id6741873881',
                                    available: true,
                                },
                                {
                                    name: 'Firefox',
                                    icon: <FaFirefox />,
                                    href: 'https://addons.mozilla.org/en-US/firefox/addon/grabcaramel/',
                                    available: true,
                                },
                                {
                                    name: 'Edge',
                                    icon: <FaEdge />,
                                    href: 'https://microsoftedge.microsoft.com/addons/detail/caramel/leodahchedhnenmiengkfpmmcdendnof',
                                    available: true,
                                },
                            ].map(browser => (
                                <a
                                    key={browser.name}
                                    href={browser.href}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-2 rounded-full bg-gray-50 px-6 py-3 text-center shadow-sm transition hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel focus-visible:ring-offset-2 dark:bg-white/5 dark:hover:bg-white/10 dark:focus-visible:ring-offset-darkSurface"
                                >
                                    {browser.icon}
                                    {browser.name}
                                </a>
                            ))}
                        </div>
                    </div>

                    <div className="rounded-2xl border border-gray-100 bg-white p-6 shadow-lg dark:border-white/10 dark:bg-darkSurface">
                        <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">
                            3,000+ Supported Stores
                        </p>
                        <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                            From major retailers to niche marketplaces, Caramel
                            works everywhere you shop online.
                        </p>
                        <Link
                            href="/supported-stores"
                            className="mt-4 inline-flex items-center justify-center rounded-full bg-gradient-to-r from-caramel to-orange-600 px-4 py-2 text-xs font-semibold text-white shadow-md transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel focus-visible:ring-offset-2 dark:focus-visible:ring-offset-darkSurface"
                        >
                            View All Supported Stores
                        </Link>
                    </div>
                </aside>
            </div>
        </div>
    )
}
