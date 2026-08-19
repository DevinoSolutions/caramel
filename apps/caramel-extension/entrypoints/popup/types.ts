/**
 * Shared popup types (WXT P2). The data shapes mirror what popup-core.js's
 * resolvePopupState() returns and what the coupons API envelope carries —
 * they are DESCRIPTIVE typings over the pinned JS contracts, not a new
 * schema; when in doubt the pinned behavior in popup-core.js wins.
 */

export interface PopupUser {
    username: string
    image: string | null
}

export interface Coupon {
    id?: number | string
    code: string
    title?: string
    description?: string
    status?: string
    verificationMessage?: string
    cartCategory?: string
    cartCategorySecondary?: string
    lastWorkedAt?: string
}

/** The page-1 envelope resolvePopupState hands through (fetchCouponsPage). */
export interface CouponsPage {
    coupons: Coupon[]
    page?: number
    total?: number
    hasMore?: boolean
}

/**
 * Whether the browser holds the every-website host grant, as
 * permission-state.js resolves it. `null` means the runtime could not tell us
 * — it is NOT `false`, and only an explicit `false` may show the banner: a
 * false alarm on a working install is worse than saying nothing.
 *
 * Deliberately NOT part of ResolvedState: it is resolved by AllSitesBanner
 * after mount, so the popup's boot never waits on a permissions API answering.
 */
export type AllSitesGranted = boolean | null

export type ResolvedState =
    | {
          view: 'coupons'
          coupons: Coupon[]
          user: PopupUser | null
          domain: string
          page: CouponsPage
      }
    | { view: 'unsupported'; user: PopupUser | null; domain?: string }
    | { view: 'profile'; user: PopupUser }
    /** The browser refused our requests outright — the host grant is missing,
     *  and the connection copy of `loadError` would send the user hunting for
     *  a network fault that does not exist. */
    | { view: 'permission' }
    | { view: 'loadError' }

/** Navigation the App hands every view. */
export interface AppApi {
    /** Open the sign-in overlay (back returns to the current view). */
    openSignIn: () => void
    /** Close any overlay, back to the resolved view. */
    closeOverlay: () => void
    /** Re-run resolvePopupState; the current view stays painted until the new
     *  state lands (vanilla-parity: re-inits never flashed the skeleton). */
    refresh: () => void
}
