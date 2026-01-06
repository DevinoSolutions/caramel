export interface Coupon {
    id: string
    code: string
    site: string
    title: string
    description: string
    rating: number
    discount_type: 'PERCENTAGE' | 'CASH' | 'SAVE'
    discount_amount: number | null
    expiry: string
    expired: boolean
    timesUsed: number
}

export interface CouponFilters {
    search: string
    site: string
    type: 'all' | 'PERCENTAGE' | 'CASH' | 'SAVE'
}
