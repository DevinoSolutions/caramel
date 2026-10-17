// src/lib/couponBoxPickAnswerCache.ts
//
// The coupon-box pick's answer cache (couponBoxPick.ts), keyed by STORE and
// then checked against the page, not keyed by the whole outline.
//
// Why: the outline is the whole page's controls with `[n]` indexes. On a
// content-rich store (Amazon: recommendation carousels, personalised rows,
// lazy-loaded blocks) two loads of the same page differ in dozens of lines, so
// a key hashed over the whole outline never repeated: 0 hits in 47 production
// picks (2026-10-14..17), the same store answered again minutes apart.
//
// What an answer depends on, though, is small:
//   - the lines it points at (a cached `input: 7` is only right while line [7]
//     is still the same control), and
//   - the coupon-flavoured lines of the page (code, coupon, promo, discount,
//     voucher, gift...): the model's "there is no box" and its choice among
//     several boxes turn on them, and on nothing else the allowlisted outline
//     words can express.
// An entry therefore applies to a new outline of the same store when every
// line it picked is unchanged at the same index AND the page's coupon-flavoured
// lines are the same set. Anything else is a miss and asks the model.
//
// In-memory, like the cache it replaces (ttlLruCache.ts): a redeploy empties
// it. TODO: move to a shared store if the app is ever scaled past one instance.
import { createTtlLruCache } from '@/lib/ttlLruCache'

/** Answers kept per store; the newest first. */
const ENTRIES_PER_STORE = 4

// Coupon vocabulary in the store languages the extension's outline word list
// keeps (coupon-box-outline.js ALLOWED_WORDS). Broad on purpose: a word
// matched here only makes a page's fingerprint more specific, which costs a
// hit, never a wrong answer.
const COUPON_FLAVOURED =
    /code|codice|kod|coupon|cup[oó]n|cupom|promo|discount|voucher|gift|redeem|gutschein|rabatt|descuento|desconto|sconto|korting|remise|r[ée]duction|zni[żz]ka|\bbons?\b/i

// One outline line: its indent, an optional `[n]` index, the rest.
const LINE = /^\s*- (?:\[(\d{1,6})\] )?(.*)$/

interface Entry<V> {
    /** Picked index -> that line as it was printed (role, name, states). */
    picked: Map<number, string>
    /** The page's coupon-flavoured lines, index-free, sorted. */
    flavoured: string
    value: V
}

interface ParsedOutline {
    /** `[n]` -> the line after the index. */
    byIndex: Map<number, string>
    flavoured: string
}

function parseOutline(outline: string): ParsedOutline {
    const byIndex = new Map<number, string>()
    const flavoured: string[] = []
    for (const raw of outline.split('\n')) {
        const m = LINE.exec(raw)
        if (!m) continue
        const text = (m[2] ?? '').trim()
        if (m[1] !== undefined) byIndex.set(Number(m[1]), text)
        if (COUPON_FLAVOURED.test(text)) flavoured.push(text)
    }
    return { byIndex, flavoured: flavoured.sort().join('\n') }
}

/** The one spelling of a store: the extension sends the store record's domain
 * on some pages and the page's host (`www.` and all) on others, and both name
 * the same store. */
export function couponBoxStoreKey(domain: string): string {
    return domain
        .trim()
        .toLowerCase()
        .replace(/^www\./, '')
}

export interface CouponBoxAnswerCache<V> {
    /** The cached answer that holds for `outline`, or null. */
    get(domain: string, outline: string): V | null
    /** Cache `value` for this store. `pickedIndexes` are the outline indexes
     * the value points at (none for "no box"); `outline` is the one the model
     * answered from. */
    set(
        domain: string,
        outline: string,
        pickedIndexes: readonly number[],
        value: V,
    ): void
}

export function createCouponBoxAnswerCache<V>(opts: {
    ttlMs: number
    maxStores: number
}): CouponBoxAnswerCache<V> {
    const stores = createTtlLruCache<Entry<V>[]>({
        ttlMs: opts.ttlMs,
        maxEntries: opts.maxStores,
    })
    return {
        get(domain, outline) {
            const entries = stores.get(couponBoxStoreKey(domain))
            if (!entries) return null
            const page = parseOutline(outline)
            const hit = entries.find(
                e =>
                    e.flavoured === page.flavoured &&
                    Array.from(e.picked).every(
                        ([index, line]) => page.byIndex.get(index) === line,
                    ),
            )
            return hit ? hit.value : null
        },
        set(domain, outline, pickedIndexes, value) {
            const key = couponBoxStoreKey(domain)
            const page = parseOutline(outline)
            const picked = new Map<number, string>()
            for (const index of pickedIndexes) {
                const line = page.byIndex.get(index)
                // The pick was validated against this outline; a line that is
                // gone means there is nothing safe to compare later.
                if (line === undefined) return
                picked.set(index, line)
            }
            const entry: Entry<V> = {
                picked,
                flavoured: page.flavoured,
                value,
            }
            // A same-shaped answer replaces its older twin, not crowds it out.
            const kept = (stores.get(key) ?? []).filter(
                e =>
                    e.flavoured !== entry.flavoured ||
                    e.picked.size !== picked.size ||
                    Array.from(e.picked).some(
                        ([index, line]) => picked.get(index) !== line,
                    ),
            )
            stores.set(key, [entry, ...kept].slice(0, ENTRIES_PER_STORE))
        },
    }
}
