import type { Coupon } from './types'

/**
 * The popup's per-shopper coupon memory (issue #288): which copied code still
 * owes the shopper a "Did it work?", which codes they already voted on, and
 * which codes they chose to hide. Everything lives in storage.local — it is
 * about THIS browser's shopping, so it neither roams via Chrome Sync nor
 * counts against its quota.
 *
 * DISPLAY ONLY. Nothing here is read by the content scripts: the auto-apply
 * order and selection (coupon-runner.js) stay exactly what the catalog ranks,
 * so a forged `keepsFailing` or a stack of fake reports can reorder what the
 * popup shows, never stop a code from being tried at checkout.
 *
 * Pure functions take the browser handle (like code-sharing-consent.js) so the
 * tests can hand them a storage stub; every storage failure REJECTS, and the
 * callers report it instead of carrying on as if the write had landed.
 */

export const PENDING_VOTE_KEY = 'caramel_pending_vote'
export const VOTED_COUPONS_KEY = 'caramel_voted_coupons'
export const HIDDEN_COUPONS_KEY = 'caramel_hidden_coupons'

/** How long a copied code stays worth asking about. Past this the shopper has
 *  long since checked out (or given up) and a vote would be a guess. */
export const PENDING_VOTE_WINDOW_MS = 2 * 60 * 60 * 1000

/** Cap on each id list (voted, hidden): oldest ids fall off first, so the
 *  record can never grow without bound across years of shopping. */
export const COUPON_ID_LIST_MAX = 500

export type Vote = 'worked' | 'failed'

/** A code the shopper copied in the popup and has not voted on yet. */
export interface PendingVote {
    couponId: string
    code: string
    site: string
    /** Epoch ms. */
    copiedAt: number
}

interface VoteState {
    pending: PendingVote | null
    voted: string[]
    hidden: string[]
}

/** Minimal storage surface (chrome.storage.local, callback style). */
interface StorageBrowser {
    storage: {
        local: {
            get: (
                keys: string[],
                cb: (res: Record<string, unknown>) => void,
            ) => void
            set: (items: Record<string, unknown>, cb: () => void) => void
        }
    }
    runtime: { lastError?: { message?: string } }
}

/** Stored value -> the record, or null when it is not exactly a valid one. */
export function parsePendingVote(raw: unknown): PendingVote | null {
    if (!raw || typeof raw !== 'object') return null
    const r = raw as Record<string, unknown>
    if (typeof r.couponId !== 'string' || !r.couponId) return null
    if (typeof r.code !== 'string' || !r.code) return null
    if (typeof r.site !== 'string' || !r.site) return null
    if (typeof r.copiedAt !== 'number' || !Number.isFinite(r.copiedAt))
        return null
    return {
        couponId: r.couponId,
        code: r.code,
        site: r.site,
        copiedAt: r.copiedAt,
    }
}

/** Stored value -> a deduplicated, capped list of non-empty id strings. */
export function parseIdList(raw: unknown): string[] {
    if (!Array.isArray(raw)) return []
    const ids = raw.filter((x): x is string => typeof x === 'string' && !!x)
    return [...new Set(ids)].slice(-COUPON_ID_LIST_MAX)
}

/** `id` appended as the newest entry (moved, not duplicated), list capped. */
export function withId(list: string[], id: string): string[] {
    return [...list.filter(x => x !== id), id].slice(-COUPON_ID_LIST_MAX)
}

/** True once a copy is past the ask window — it will never be asked about,
 *  on any site. A future timestamp (clock skew) is not "expired". */
export const pendingVoteExpired = (
    pending: PendingVote,
    now: number = Date.now(),
): boolean => now - pending.copiedAt > PENDING_VOTE_WINDOW_MS

/** The pending vote worth asking about NOW, or null: it must be for this
 *  site, still inside the window (a future timestamp is clock skew, not
 *  "fresh"), and not already voted. */
export function pendingVoteToAsk(
    state: Pick<VoteState, 'pending' | 'voted'>,
    site: string,
    now: number = Date.now(),
): PendingVote | null {
    const p = state.pending
    if (!p || p.site !== site) return null
    if (p.copiedAt > now || pendingVoteExpired(p, now)) return null
    if (state.voted.includes(p.couponId)) return null
    return p
}

/** Catalog id as a string, or null for the rare row that arrives without one
 *  (it can be neither hidden nor voted on — there is nothing to key it by). */
export const couponKey = (c: Pick<Coupon, 'id'>): string | null =>
    c.id != null && c.id !== '' ? String(c.id) : null

interface CouponSplit {
    /** Shown in the main list, in the order the catalog gave them. */
    main: Coupon[]
    /** Server says it keeps failing (and the shopper has not hidden it). */
    failing: Coupon[]
    /** The shopper hid these themselves — wins over `failing`. */
    hidden: Coupon[]
}

/** Partitions the list for display. A missing `keepsFailing` (an older server)
 *  is "not failing" — only an explicit `true` moves a code. */
export function splitCoupons(
    coupons: Coupon[],
    hiddenIds: readonly string[],
): CouponSplit {
    const hiddenSet = new Set(hiddenIds)
    const out: CouponSplit = { main: [], failing: [], hidden: [] }
    for (const c of coupons) {
        const key = couponKey(c)
        if (key !== null && hiddenSet.has(key)) out.hidden.push(c)
        else if (c.keepsFailing === true) out.failing.push(c)
        else out.main.push(c)
    }
    return out
}

/** One storage.local call as a promise: lastError and a synchronous throw both
 *  REJECT, so a broken storage is never mistaken for an empty one. */
function local<T>(
    browser: StorageBrowser,
    what: 'read' | 'write',
    call: (done: (res?: T) => void) => void,
): Promise<T> {
    return new Promise((resolve, reject) => {
        try {
            call(res => {
                const err = browser.runtime.lastError
                if (err) {
                    reject(
                        new Error(`coupon vote ${what} failed: ${err.message}`),
                    )
                    return
                }
                resolve(res as T)
            })
        } catch (err) {
            reject(err)
        }
    })
}

const read = (browser: StorageBrowser, keys: string[]) =>
    local<Record<string, unknown>>(browser, 'read', done =>
        browser.storage.local.get(keys, done),
    )

const write = (browser: StorageBrowser, items: Record<string, unknown>) =>
    local<void>(browser, 'write', done =>
        browser.storage.local.set(items, done),
    )

export async function readVoteState(
    browser: StorageBrowser,
): Promise<VoteState> {
    const res = await read(browser, [
        PENDING_VOTE_KEY,
        VOTED_COUPONS_KEY,
        HIDDEN_COUPONS_KEY,
    ])
    return {
        pending: parsePendingVote(res?.[PENDING_VOTE_KEY]),
        voted: parseIdList(res?.[VOTED_COUPONS_KEY]),
        hidden: parseIdList(res?.[HIDDEN_COUPONS_KEY]),
    }
}

/** Remembers the code the shopper just copied so the NEXT popup open on this
 *  site can ask whether it worked. One slot: the latest copy wins. A coupon
 *  without an id cannot be voted on, so it leaves the slot untouched. */
export async function rememberCopiedCoupon(
    browser: StorageBrowser,
    coupon: Pick<Coupon, 'id' | 'code'>,
    site: string,
    now: number = Date.now(),
): Promise<void> {
    const couponId = couponKey(coupon)
    if (couponId === null) return
    const pending: PendingVote = {
        couponId,
        code: coupon.code,
        site,
        copiedAt: now,
    }
    await write(browser, { [PENDING_VOTE_KEY]: pending })
}

/** The vote went out: remember it (one vote per coupon), clear the pending
 *  slot, and — for a "didn't work" — hide the code for this shopper. */
export async function recordVote(
    browser: StorageBrowser,
    couponId: string,
    vote: Vote,
): Promise<void> {
    const state = await readVoteState(browser)
    const items: Record<string, unknown> = {
        [VOTED_COUPONS_KEY]: withId(state.voted, couponId),
        [PENDING_VOTE_KEY]: null,
    }
    if (vote === 'failed')
        items[HIDDEN_COUPONS_KEY] = withId(state.hidden, couponId)
    await write(browser, items)
}

/** "Not now": drop the question without a vote, so it is not asked again. */
export async function clearPendingVote(browser: StorageBrowser): Promise<void> {
    await write(browser, { [PENDING_VOTE_KEY]: null })
}

export async function setCouponHidden(
    browser: StorageBrowser,
    couponId: string,
    hide: boolean,
): Promise<string[]> {
    const state = await readVoteState(browser)
    const next = hide
        ? withId(state.hidden, couponId)
        : state.hidden.filter(x => x !== couponId)
    await write(browser, { [HIDDEN_COUPONS_KEY]: next })
    return next
}
