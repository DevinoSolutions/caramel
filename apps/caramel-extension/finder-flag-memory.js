// owns: the last promo-box finder flag the server gave this install, kept in
// storage.local so a content script can still read it when the background
// cannot answer (T-10668).
//
// The background writes it each time it fetches the features
// (background.js _fetchFeatures). A content script reads it only after asking
// the background twice and getting no answer (coupon-box-finder-loader.js).
// It is trusted for 30 minutes, the same lifetime the background gives a
// cached features read while the finder is on (FEATURES_TTL_OFF_MS), so
// switching the finder off on the server still reaches every install within
// 30 minutes. Older than that, or not shaped right, it is no answer at all.
//
// No top-level effects: two realms import this module.

export const FINDER_FLAG_MEMORY_KEY = 'caramel_finder_flag'
const FINDER_FLAG_MEMORY_MAX_AGE_MS = 30 * 60 * 1000

// The record to store for a flag read from the server at `ts`.
export const finderFlagMemoryEntry = (on, ts) => ({ on: on === true, ts })

// The remembered flag, or null when there is none worth trusting at `now`.
export function finderFlagFromMemory(record, now) {
    if (typeof record?.on !== 'boolean' || typeof record.ts !== 'number')
        return null
    const age = now - record.ts
    return age >= 0 && age < FINDER_FLAG_MEMORY_MAX_AGE_MS ? record.on : null
}
