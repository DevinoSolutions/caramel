import type { AppApi, CouponsPage, PopupUser } from '../types'

/**
 * TODO(WXT-P2 agent C): PLACEHOLDER — the coupons list is NOT built yet.
 *
 * The real view ports popup.js renderCouponsView + createCouponCard per
 * P2-POPUP-SPEC.md invariants 8–11 (card markup + STATUS_META badges,
 * delegated copy + toast, IntersectionObserver paging with the seen-set and
 * COUPON_PAGE_EMPTY_LIMIT auto-chase, GUEST_COUPON_LIMIT gate slicing AFTER
 * the paging state is built, the favorite star's disabled-until-truth +
 * optimistic-reconcile contract) and re-enables the .p2disabled suites:
 * popup-coupon-badges, popup-coupon-paging, popup-favorite-store.
 *
 * If you are reading this on main, the port was dropped: treat it as a
 * release blocker, not a cleanup item.
 */
export function CouponsView(_props: {
    coupons: unknown[]
    user: PopupUser | null
    domain: string
    page: CouponsPage
    api: AppApi
}) {
    return (
        <div className="no-coupons-view">
            <h3>Coupons view under construction</h3>
            <p>WXT-P2 agent C owns this surface — see the TODO above.</p>
        </div>
    )
}
