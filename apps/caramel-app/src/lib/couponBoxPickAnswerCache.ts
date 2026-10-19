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
//     is still the same control, with the same lines on either side), and
//   - the coupon-flavoured lines of the page (code, coupon, promo, discount,
//     voucher, apply, enter...) and its text-entry fields: the model's "there
//     is no box" and its choice among several boxes turn on them, and on
//     nothing else the allowlisted outline words can express.
// An entry therefore applies to a new outline of the same store when every
// line it picked is unchanged at the same index AND the page's fingerprint of
// those lines is the same set. Anything else is a miss and asks the model.
//
// In-memory, like the cache it replaces (ttlLruCache.ts): a redeploy empties
// it. TODO: move to a shared store if the app is ever scaled past one instance.
import { createTtlLruCache } from '@/lib/ttlLruCache'
import crypto from 'node:crypto'

/** Answers kept per store; the newest first. */
const ENTRIES_PER_STORE = 4

// Coupon vocabulary in the store languages the extension's outline word list
// keeps (coupon-box-outline.js ALLOWED_WORDS), plus the verbs a box's own
// button or toggle carries (apply, enter, have a code?). Broad on purpose: a
// word matched here only makes a page's fingerprint more specific, which costs
// a hit, never a wrong answer.
const COUPON_FLAVOURED =
    /code|codice|kod|coupon|cup[oó]n|cupom|promo|discount|voucher|gift|redeem|gutschein|rabatt|descuento|desconto|sconto|korting|remise|r[ée]duction|zni[żz]ka|\bbons?\b|\bapply\b|\benter\b|\bhave\b|einlösen|anwenden|aplicar|appliquer|applica|toepassen|canjear|resgatar|saisir|inserisci|invoeren|eingeben/i

// A field a shopper types into. A box can carry no coupon word at all (the
// store wrote only "Enter" or nothing), so every such field is part of the
// fingerprint: a page that gains one is never served a cached "no box".
const TEXT_ENTRY = /^(?:textbox|searchbox|combobox)\b/

// One outline line: its indent, an optional `[n]` index, the rest.
const LINE = /^\s*- (?:\[(\d{1,6})\] )?(.*)$/

/** A picked line as it was printed, with the lines on either side of it: a
 * name-less line (`textbox`) is told apart by what surrounds it. */
interface PickedLine {
    line: string
    before: string
    after: string
}

interface Entry<V> {
    /** Picked index -> the line it named. */
    picked: Map<number, PickedLine>
    /** sha256 of the page's coupon-flavoured and text-entry lines (index-free,
     * sorted): constant size however long the outline, compared by equality. */
    fingerprint: string
    /** When it was cached (ms), so each entry expires on its own clock. */
    at: number
    value: V
}

interface ParsedOutline {
    /** `[n]` -> that line and its neighbours. */
    byIndex: Map<number, PickedLine>
    fingerprint: string
}

function parseOutline(outline: string): ParsedOutline {
    const lines: { index: number | null; text: string; raw: string }[] = []
    for (const raw of outline.split('\n')) {
        const m = LINE.exec(raw)
        if (!m) continue
        lines.push({
            index: m[1] === undefined ? null : Number(m[1]),
            text: (m[2] ?? '').trim(),
            raw: raw.trim(),
        })
    }
    const byIndex = new Map<number, PickedLine>()
    const fingerprint: string[] = []
    lines.forEach((l, i) => {
        if (l.index !== null)
            byIndex.set(l.index, {
                line: l.text,
                before: lines[i - 1]?.raw ?? '',
                after: lines[i + 1]?.raw ?? '',
            })
        if (COUPON_FLAVOURED.test(l.text) || TEXT_ENTRY.test(l.text))
            fingerprint.push(l.text)
    })
    return {
        byIndex,
        fingerprint: crypto
            .createHash('sha256')
            .update(fingerprint.sort().join('\n'))
            .digest('hex'),
    }
}

const samePicked = (a: PickedLine | undefined, b: PickedLine): boolean =>
    a !== undefined &&
    a.line === b.line &&
    a.before === b.before &&
    a.after === b.after

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
    // The outer cache bounds the number of stores; each entry carries its own
    // clock, because re-stamping a store's list on every add would keep a stale
    // answer alive for as long as its store keeps getting new ones.
    const stores = createTtlLruCache<Entry<V>[]>({
        ttlMs: opts.ttlMs,
        maxEntries: opts.maxStores,
    })
    const live = (e: Entry<V>) => Date.now() - e.at < opts.ttlMs
    return {
        get(domain, outline) {
            const entries = stores.get(couponBoxStoreKey(domain))
            if (!entries) return null
            const page = parseOutline(outline)
            const hit = entries.find(
                e =>
                    live(e) &&
                    e.fingerprint === page.fingerprint &&
                    Array.from(e.picked).every(([index, picked]) =>
                        samePicked(page.byIndex.get(index), picked),
                    ),
            )
            return hit ? hit.value : null
        },
        set(domain, outline, pickedIndexes, value) {
            const key = couponBoxStoreKey(domain)
            const page = parseOutline(outline)
            const picked = new Map<number, PickedLine>()
            for (const index of pickedIndexes) {
                const line = page.byIndex.get(index)
                // The pick was validated against this outline; a line that is
                // gone means there is nothing safe to compare later.
                if (line === undefined) return
                picked.set(index, line)
            }
            const entry: Entry<V> = {
                picked,
                fingerprint: page.fingerprint,
                at: Date.now(),
                value,
            }
            // Expired entries go, and a same-shaped answer replaces its older
            // twin instead of crowding it out.
            const kept = (stores.get(key) ?? []).filter(
                e =>
                    live(e) &&
                    (e.fingerprint !== entry.fingerprint ||
                        e.picked.size !== picked.size ||
                        Array.from(e.picked).some(
                            ([index, p]) => !samePicked(picked.get(index), p),
                        )),
            )
            stores.set(key, [entry, ...kept].slice(0, ENTRIES_PER_STORE))
        },
    }
}
