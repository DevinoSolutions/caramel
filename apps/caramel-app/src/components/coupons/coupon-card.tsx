'use client'

import type { Coupon } from '@/types/coupon'
import { motion } from 'framer-motion'
import { useState } from 'react'
import { HiCheckCircle } from 'react-icons/hi'
import { toast } from 'sonner'

interface CouponCardProps {
    coupon: Coupon
    index: number
}

export default function CouponCard({ coupon, index }: CouponCardProps) {
    const [showCode, setShowCode] = useState(false)

    const handleCopyCode = async () => {
        if (coupon.code) {
            await navigator.clipboard.writeText(coupon.code)
            toast.success('Coupon code copied!')
            setShowCode(true)
            setTimeout(() => setShowCode(false), 3000)
        }
    }

    const discount = coupon.discount_amount
        ? coupon.discount_type === 'PERCENTAGE'
            ? `${coupon.discount_amount}%`
            : `$${coupon.discount_amount}`
        : '20%'

    const timesUsed = coupon.timesUsed ?? 0

    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={{ duration: 0.3, delay: index * 0.05 }}
            className="group relative overflow-hidden rounded-3xl border border-orange-100 bg-gradient-to-br from-orange-50/50 via-white to-orange-50/40 p-5 shadow-md transition-all hover:shadow-lg dark:border-orange-900/50 dark:from-gray-900 dark:via-gray-900 dark:to-gray-900"
        >
            <div className="flex items-center gap-5 md:flex-col md:items-start">
                {/* Left: Discount Badge */}
                <div className="from-caramel flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br to-orange-600 text-white shadow-md ring-1 ring-orange-200 dark:ring-orange-900/50">
                    <div className="text-center leading-tight">
                        <span className="block text-xl font-black md:text-lg">
                            {discount}
                        </span>
                        <span className="text-[11px] font-semibold text-white/90">
                            off
                        </span>
                    </div>
                </div>

                {/* Middle: Content */}
                <div className="min-w-0 flex-1">
                    <h3 className="mb-1 line-clamp-2 text-lg font-semibold text-gray-900 dark:text-white">
                        {coupon.title}
                    </h3>
                    {coupon.description && (
                        <p className="mb-2 line-clamp-1 text-sm text-gray-600 dark:text-gray-400">
                            {coupon.description}
                        </p>
                    )}
                    <div className="flex items-center gap-3 text-xs font-semibold text-gray-600 dark:text-gray-300">
                        <span className="flex items-center gap-1.5">
                            <HiCheckCircle className="h-4 w-4 text-emerald-500" />
                            Coupon verified
                        </span>
                        <span className="flex items-center gap-1.5">
                            <HiCheckCircle className="h-4 w-4 text-orange-500" />
                            {timesUsed} used today
                        </span>
                    </div>
                </div>

                {/* Right: CTA Button */}
                <div className="shrink-0 md:w-full">
                    <button
                        onClick={handleCopyCode}
                        className="from-caramel whitespace-nowrap rounded-2xl bg-gradient-to-r to-orange-600 px-6 py-3 font-semibold text-white shadow-md transition-all hover:scale-105 hover:shadow-lg md:w-full"
                    >
                        Get Coupon Code
                    </button>
                </div>
            </div>

            {/* Hover Overlay - Show Code */}
            {showCode && coupon.code && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="absolute inset-0 flex items-center justify-center bg-black/90 backdrop-blur-sm"
                >
                    <div className="text-center">
                        <p className="mb-2 text-sm text-gray-300">Your Code:</p>
                        <p className="from-caramel mb-3 bg-gradient-to-r to-orange-600 bg-clip-text text-3xl font-black text-transparent">
                            {coupon.code}
                        </p>
                        <p className="text-xs text-gray-400">
                            Code copied to clipboard!
                        </p>
                    </div>
                </motion.div>
            )}
        </motion.div>
    )
}
