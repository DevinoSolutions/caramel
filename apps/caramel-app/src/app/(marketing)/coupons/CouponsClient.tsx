"use client"

import Image from 'next/image'
import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { event as gaEvent } from '@/lib/gtag'

export type Coupon = {
    id: string
    title?: string
    description: string
    site: string
    code?: string | null
    createdAt?: string
}

type SortKey = 'newest' | 'oldest'
type TabKey = 'all' | 'promo' | 'online' | 'instore'

function useDebounced<T>(value: T, delayMs: number): T {
    const [debounced, setDebounced] = useState(value)
    useEffect(() => {
        const id = setTimeout(() => setDebounced(value), delayMs)
        return () => clearTimeout(id)
    }, [value, delayMs])
    return debounced
}

export default function CouponsClient() {
    const router = useRouter()
    const params = useSearchParams()

    const [search, setSearch] = useState(params.get('q') || '')
    const [sortBy, setSortBy] = useState<SortKey>((params.get('sort') as SortKey) || 'newest')
    const [activeTab, setActiveTab] = useState<TabKey>((params.get('tab') as TabKey) || 'all')
    const [isLoading, setIsLoading] = useState(false)
    const [coupons, setCoupons] = useState<Coupon[]>([])
    const [skip, setSkip] = useState(0)
    const [hasMore, setHasMore] = useState(true)

    const debouncedSearch = useDebounced(search, 300)

    const syncUrl = useCallback(
        (next: { q?: string; sort?: SortKey; tab?: TabKey }) => {
            const sp = new URLSearchParams(window.location.search)
            if (next.q !== undefined) {
                if (next.q) sp.set('q', next.q)
                else sp.delete('q')
            }
            if (next.sort) sp.set('sort', next.sort)
            if (next.tab) sp.set('tab', next.tab)
            const qs = sp.toString()
            router.replace(`?${qs}`, { scroll: false })
        },
        [router],
    )

    const load = useCallback(
        async (append: boolean) => {
            setIsLoading(true)
            try {
                const sp = new URLSearchParams()
                sp.set('limit', '20')
                sp.set('skip', String(append ? skip : 0))
                if (debouncedSearch) sp.set('key_words', debouncedSearch)
                const res = await fetch(`/api/coupons?${sp.toString()}`, {
                    cache: 'no-store',
                })
                const raw = await res.json()
                const data = Array.isArray(raw) ? (raw as Coupon[]) : []
                setCoupons(prev => (append ? [...(Array.isArray(prev) ? prev : []), ...data] : data))
                setHasMore(data.length === 20)
                setSkip(append ? skip + data.length : data.length)
            } catch {
                if (!append) setCoupons([])
                setHasMore(false)
            } finally {
                setIsLoading(false)
            }
        },
        [debouncedSearch, skip],
    )

    useEffect(() => {
        // initial load from URL
        load(false)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [debouncedSearch])

    const filtered = useMemo(() => {
        const list = Array.isArray(coupons) ? coupons : []
        const byTab = list.filter(c => {
            if (activeTab === 'all') return true
            if (activeTab === 'promo') return !!c.code
            const desc = c.description?.toLowerCase() || ''
            if (activeTab === 'online') return desc.includes('online') || !c.code
            if (activeTab === 'instore')
                return desc.includes('in-store') || desc.includes('in store')
            return true
        })

        const bySearch = debouncedSearch
            ? byTab.filter(c =>
                  [c.title, c.description, c.site]
                      .filter(Boolean)
                      .join(' ')
                      .toLowerCase()
                      .includes(debouncedSearch.toLowerCase()),
              )
            : byTab

        const sorted = [...bySearch].sort((a, b) => {
            const at = a.createdAt ? new Date(a.createdAt).getTime() : 0
            const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0
            return sortBy === 'newest' ? bt - at : at - bt
        })
        return sorted
    }, [coupons, activeTab, debouncedSearch, sortBy])

    const onCopy = async (code?: string | null) => {
        if (!code) return
        try {
            await navigator.clipboard.writeText(code)
        } catch {}
    }

    return (
        <div className="space-y-3">
            {/* Controls */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white px-3 py-2 shadow">
                <div className="flex flex-wrap items-center gap-1">
                    {(
                        [
                            { key: 'all', label: 'All Coupons', count: 12 },
                            { key: 'promo', label: 'Promo Codes', count: 7 },
                            { key: 'online', label: 'Online Sales', count: 3 },
                            { key: 'instore', label: 'In-Store Offers', count: 2 },
                        ] as { key: TabKey; label: string }[]
                    ).map((t: any, i) => (
                        <button
                            key={t.key}
                            onClick={() => {
                                setActiveTab(t.key)
                                syncUrl({ tab: t.key })
                            }}
                            className={`rounded-full px-3 py-1.5 text-[11px] transition ${
                                activeTab === t.key
                                    ? 'bg-caramel text-white shadow'
                                    : 'text-caramel hover:bg-orange-50'
                            }`}
                        >
                            {t.label}
                            {typeof t.count === 'number' && (
                                <span className={`ml-1 rounded-full bg-white/20 px-1.5 text-[10px] ${
                                    activeTab === t.key ? 'text-white' : 'text-caramel'
                                }`}>
                                    {t.count}
                                </span>
                            )}
                        </button>
                    ))}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    <input
                        placeholder="Search coupons or stores..."
                        value={search}
                        onChange={e => {
                            setSearch(e.target.value)
                            syncUrl({ q: e.target.value })
                        }}
                        className="w-56 rounded-full border border-gray-200 px-3 py-1.5 text-[11px] outline-none focus:ring-2 focus:ring-orange-200"
                    />
                    <select
                        value={sortBy}
                        onChange={e => {
                            const v = e.target.value as SortKey
                            setSortBy(v)
                            syncUrl({ sort: v })
                        }}
                        className="rounded-full border border-gray-200 px-3 py-1.5 text-[11px] text-gray-700 outline-none focus:ring-2 focus:ring-orange-200"
                    >
                        <option value="newest">Newest</option>
                        <option value="oldest">Oldest</option>
                    </select>
                </div>
            </div>

            {/* List */}
            <div className="space-y-3">
                {isLoading && (
                    <div className="rounded-xl bg-white p-4 text-xs text-gray-600 shadow">
                        Loading coupons...
                    </div>
                )}
                {!isLoading && filtered.length === 0 && (
                    <div className="rounded-xl bg-white p-4 text-xs text-gray-600 shadow">
                        No coupons found.
                    </div>
                )}
                {filtered.map(c => (
                    <article
                        key={c.id}
                        className="flex items-stretch justify-between gap-4 rounded-xl border border-orange-100 bg-white p-4 shadow-sm"
                    >
                        <div className="flex w-16 shrink-0 flex-col items-center justify-center rounded-lg border border-orange-200 bg-orange-50 text-orange-500">
                            <span className="text-lg font-bold leading-none">20%</span>
                            <span className="text-[10px] uppercase">off</span>
                        </div>
                        <div className="min-w-0 flex-1">
                            <Link
                                href={`https://${c.site}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[13px] font-semibold text-gray-900 hover:underline"
                            >
                                {c.title || `${c.site} Coupon`}
                            </Link>
                            <p className="mt-1 line-clamp-2 text-[11px] text-gray-600">
                                {c.description}{' '}
                                <span className="text-caramel cursor-pointer">More</span>
                            </p>
                        </div>
                        <div className="flex w-40 shrink-0 flex-col items-end justify-center">
                            <button
                                onClick={() => {
                                    onCopy(c.code)
                                    gaEvent({
                                        action: 'copy_coupon',
                                        event_category: 'coupons',
                                        event_label: c.code || undefined,
                                    })
                                    // toast
                                    const el = document.createElement('div')
                                    el.textContent = c.code ? 'Copied!' : 'Opening deal…'
                                    el.className = 'fixed bottom-5 left-1/2 -translate-x-1/2 rounded-full bg-black/80 px-3 py-2 text-xs text-white'
                                    document.body.appendChild(el)
                                    setTimeout(() => el.remove(), 1000)
                                }}
                                disabled={!c.code}
                                className={`rounded-md px-3 py-2 text-[11px] font-semibold text-white ${
                                    c.code
                                        ? 'bg-caramel hover:bg-[#ff7a45]'
                                        : 'bg-gray-300'
                                }`}
                                title={c.code ? `Copy ${c.code}` : 'No code available'}
                            >
                                {c.code ? 'Get Coupon Code' : 'Get Deal'}
                            </button>
                            <div className="mt-1 flex flex-col items-end leading-tight">
                                <p className="text-[10px] text-gray-500">
                                    <span className="text-green-600">✓</span> Coupon verified
                                </p>
                                <p className="text-[10px] text-gray-400">423 used today</p>
                            </div>
                        </div>
                    </article>
                ))}
                {hasMore && (
                    <div className="flex justify-center">
                        <button
                            onClick={() => load(true)}
                            className="rounded-full bg-white px-4 py-2 text-[11px] text-caramel shadow hover:bg-orange-50"
                        >
                            Load more
                        </button>
                    </div>
                )}
            </div>
        </div>
    )
}


