// src/lib/ttlLruCache.ts
//
// The in-memory answer cache shared by the app's LLM surfaces (the cart
// classifier and the coupon-box pick): a Map in insertion order, read hits
// moved to the end (least-recently-used first out), a fixed entry cap and a
// per-entry time-to-live. One home, so the two surfaces cannot drift into
// two subtly different caches.
//
// In-memory: correct for the ONE web instance the root compose runs, like
// rateLimit.ts and the model-call budgets. TODO: move to a shared store if
// the app is ever scaled past one instance (each would keep its own cache).

export interface TtlLruCache<V> {
    /** The live value for `key`, or null when absent or expired. A hit
     * refreshes the entry's LRU position (not its expiry). */
    get(key: string): V | null
    /** Store `value`; evicts the least-recently-used entry when full. */
    set(key: string, value: V): void
}

export function createTtlLruCache<V>(opts: {
    ttlMs: number
    maxEntries: number
}): TtlLruCache<V> {
    const entries = new Map<string, { expires: number; value: V }>()
    return {
        get(key) {
            const entry = entries.get(key)
            if (!entry) return null
            if (entry.expires < Date.now()) {
                entries.delete(key)
                return null
            }
            // Refresh LRU ordering
            entries.delete(key)
            entries.set(key, entry)
            return entry.value
        },
        set(key, value) {
            if (entries.size >= opts.maxEntries) {
                const oldest = entries.keys().next().value
                if (oldest) entries.delete(oldest)
            }
            entries.set(key, { expires: Date.now() + opts.ttlMs, value })
        },
    }
}
