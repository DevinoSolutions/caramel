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

export interface LoadingTtlLruCache<V> {
    /** The live value for `key`; on a miss runs `loader` ONCE (concurrent
     * callers of the same key share that one run) and stores its result. A
     * loader that throws is NOT stored and every sharer sees the error. */
    load(key: string, loader: () => Promise<V>): Promise<V>
    /** Drop every entry and forget in-flight loads (tests). */
    reset(): void
}

/**
 * A TtlLruCache that also owns the miss path, for the anonymous DB-heavy reads
 * (T-6226): the cache key is chosen by the CALLER from already-parsed params,
 * so a unique query string or an unknown param can never produce a fresh key,
 * and a stampede after expiry runs one query instead of N.
 */
export function createLoadingTtlLruCache<V>(opts: {
    ttlMs: number
    maxEntries: number
}): LoadingTtlLruCache<V> {
    let cache = createTtlLruCache<V>(opts)
    let inFlight = new Map<string, Promise<V>>()
    return {
        load(key, loader) {
            const hit = cache.get(key)
            if (hit !== null) return Promise.resolve(hit)
            const running = inFlight.get(key)
            if (running) return running
            // Generation guard: a load that started before reset() must not
            // repopulate (or un-register) the post-reset state.
            const startedCache = cache
            const startedInFlight = inFlight
            const pending: Promise<V> = loader()
                .then(value => {
                    if (startedCache === cache) cache.set(key, value)
                    return value
                })
                .finally(() => {
                    if (startedInFlight.get(key) === pending) {
                        startedInFlight.delete(key)
                    }
                })
            inFlight.set(key, pending)
            return pending
        },
        reset() {
            cache = createTtlLruCache<V>(opts)
            inFlight = new Map()
        },
    }
}
