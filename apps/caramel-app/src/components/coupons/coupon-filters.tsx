'use client'

import type { CouponFilters } from '@/types/coupon'
import { MagnifyingGlassIcon, XMarkIcon } from '@heroicons/react/24/outline'
import debounce from 'lodash.debounce'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { FaFilter } from 'react-icons/fa'
import Select from 'react-select'
import AsyncSelect from 'react-select/async'

interface CouponFiltersProps {
    filters: CouponFilters
    onChange: (filters: Partial<CouponFilters>) => void
    storeOptions?: string[]
    discountOptions?: string[]
    onClearAll?: () => void
}

export default function CouponFilters({
    filters,
    onChange,
    storeOptions = [],
    discountOptions = [],
    onClearAll,
}: CouponFiltersProps) {
    type Option = { value: string; label: string }
    const [localSearch, setLocalSearch] = useState(filters.search)
    const [showFilters, setShowFilters] = useState(false)

    const debouncedSearch = useMemo(
        () =>
            debounce((value: string) => {
                onChange({ search: value })
            }, 400),
        [onChange],
    )

    useEffect(() => () => debouncedSearch.cancel(), [debouncedSearch])

    const handleSearchChange = (value: string) => {
        setLocalSearch(value)
        debouncedSearch(value)
    }

    const loadStoreOptions = useCallback(
        async (inputValue: string): Promise<Option[]> => {
            const query = inputValue?.trim() || ''
            const params = new URLSearchParams({ q: query, limit: '20' })
            try {
                const res = await fetch(`/api/coupons/stores?${params}`)
                if (!res.ok) throw new Error('Failed to fetch stores')
                const data = await res.json()
                const combined = Array.from(
                    new Set([...(data.sites || []), ...storeOptions]),
                )
                return combined.map(site => ({ value: site, label: site }))
            } catch (err) {
                console.error('Failed to load store options:', err)
                return []
            }
        },
        [storeOptions],
    )

    const selectedStore =
        filters.site && filters.site.length
            ? { value: filters.site, label: filters.site }
            : null

    const normalizeOptions = (opts: string[]): Option[] =>
        opts.map(type => ({
            value: type,
            label:
                type.charAt(0) + type.slice(1).toLowerCase().replace(/_/g, ' '),
        }))

    const resolvedDiscountOptions = normalizeOptions(
        discountOptions.length
            ? discountOptions
            : ['PERCENTAGE', 'CASH', 'SAVE'],
    )

    const selectedDiscount =
        filters.type && filters.type !== 'all'
            ? normalizeOptions([filters.type])[0]
            : null

    const selectStyles = {
        control: (base: any) => ({
            ...base,
            borderColor: '#fbd0b2',
            boxShadow: 'none',
            paddingLeft: '4px',
            paddingRight: '4px',
            minHeight: '44px',
            backgroundColor: 'var(--tw-prose-body, white)',
            width: '100%',
        }),
        menu: (base: any) => ({ ...base, zIndex: 20 }),
    }

    return (
        <div className="mb-8 space-y-3">
            <div className="flex flex-wrap items-end gap-3">
                {/* Search */}
                <div className="min-w-[220px] flex-1">
                    <label className="mb-2 block text-sm font-semibold text-gray-700 dark:text-gray-300">
                        Search
                    </label>
                    <div className="relative">
                        <MagnifyingGlassIcon className="text-caramel absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2" />
                        <input
                            type="text"
                            value={localSearch}
                            onChange={e => handleSearchChange(e.target.value)}
                            placeholder="Search coupons by site, title, or description..."
                            className="border-caramel/30 focus:border-caramel w-full rounded-md border-2 bg-white px-3 py-[11px] pl-10 text-sm outline-none transition-all dark:bg-gray-900 dark:text-white dark:placeholder-gray-500 dark:focus:border-orange-400"
                        />
                    </div>
                </div>

                {/* Store Filter */}
                <div className="min-w-[220px] flex-1">
                    <label className="mb-2 block text-sm font-semibold text-gray-700 dark:text-gray-300">
                        Store
                    </label>
                    <AsyncSelect
                        cacheOptions
                        defaultOptions
                        loadOptions={loadStoreOptions}
                        placeholder="Search stores..."
                        value={selectedStore}
                        onChange={(opt: Option | null) =>
                            onChange({ site: opt?.value || '' })
                        }
                        isClearable
                        styles={selectStyles}
                        classNamePrefix="store-select"
                    />
                </div>

                {/* Type Filter */}
                <div className="min-w-[200px] flex-1">
                    <label className="mb-2 block text-sm font-semibold text-gray-700 dark:text-gray-300">
                        Discount Type
                    </label>
                    <Select
                        isClearable
                        isSearchable={false}
                        placeholder="All discount types"
                        options={resolvedDiscountOptions}
                        value={selectedDiscount}
                        onChange={(opt: Option | null) =>
                            onChange({
                                type:
                                    (opt?.value as CouponFilters['type']) ||
                                    'all',
                            })
                        }
                        styles={selectStyles}
                        classNamePrefix="discount-select"
                    />
                </div>

                {/* Clear Filters Button */}
                {(filters.search || filters.site || filters.type !== 'all') && (
                    <button
                        onClick={() => {
                            setLocalSearch('')
                            onChange({ search: '', site: '', type: 'all' })
                            onClearAll?.()
                        }}
                        className="from-caramel flex h-11 w-11 items-center justify-center rounded-full bg-gradient-to-r to-orange-600 text-white shadow-md transition hover:opacity-90"
                        title="Clear filters"
                    >
                        <XMarkIcon className="h-5 w-5" />
                    </button>
                )}
            </div>

            {/* Mobile toggle (md and down per custom breakpoints) */}
            <button
                onClick={() => setShowFilters(!showFilters)}
                className="text-caramel mt-2 hidden w-full items-center justify-center gap-2 rounded-full bg-white px-6 py-3 shadow-md transition-all hover:shadow-lg md:flex dark:bg-gray-900 dark:text-orange-400"
            >
                <FaFilter className="h-4 w-4" />
                <span className="font-semibold">Filters</span>
            </button>

            <div
                className={`${showFilters ? 'max-h-full' : 'md:max-h-0'} overflow-visible transition-all duration-300 md:overflow-hidden`}
            />
        </div>
    )
}
