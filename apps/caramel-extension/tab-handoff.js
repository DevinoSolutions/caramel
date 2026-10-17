/* --------------------------------------------------  per-tab handoffs
 *
 * What one document of a tab leaves for the next one: the code submitted
 * before a form POST reloaded the cart (pending_submit), the discount-link win
 * re-shown after its own reload (applied), the run carried across
 * navigations (run), the promo-box finder's server pick (box_pick), and the
 * box a run used, confirmed on the page its submit reloads to (box_learn).
 *
 * These used to live in the page's sessionStorage, which the store's own page
 * can read and write. The pending-submit record decides whether a code is
 * reported as having worked and what saving is recorded, so it has to live
 * where only the extension writes: here, in the background, keyed by the tab
 * that wrote it and stamped with the origin it was written on. The tab and the
 * origin come from the message's sender, never from the message.
 *
 * A record written on one site is never read on another, nor in another tab.
 * Each kind has its own lifetime; a stale record is dropped when read. A tab
 * that closes forgets its records.
 *
 * Backed by storage.session when the browser has it (a restarted service
 * worker keeps the record), memory otherwise. Every operation runs in order,
 * so a clear sent before the next set is applied before it, and a replace
 * reads and writes as one step: nothing lands between the two.
 *
 * Called from background.js. */

// Each handoff kind, and how long it waits for the next document.
export const TAB_HANDOFFS = {
    pending_submit: 2 * 60 * 1000,
    applied: 2 * 60 * 1000,
    run: 3 * 60 * 1000,
    // That the server was asked for a store's box in this tab, and the names
    // of a usable pick for the next page: kept for a shopping session.
    box_pick: 12 * 60 * 60 * 1000,
    box_learn: 2 * 60 * 1000,
}
// Measured in UTF-8 bytes, not characters.
const MAX_BYTES = 4096
const bytes = s => new TextEncoder().encode(s).length
const PREFIX = 'caramel_tab:'

export function caramelTabHandoffs(area = null) {
    const memory = new Map()
    // The callback form of the storage API, which every browser we ship to
    // answers (the promise form is not universal).
    const call = (method, arg) =>
        new Promise((resolve, reject) => {
            try {
                area[method](arg, resolve)
            } catch (err) {
                reject(err)
            }
        })
    const read = async slot =>
        area
            ? ((await call('get', [slot]))?.[slot] ?? null)
            : (memory.get(slot) ?? null)
    const write = async (slot, entry) =>
        area ? call('set', { [slot]: entry }) : memory.set(slot, entry)
    const drop = async slots =>
        area ? call('remove', slots) : slots.forEach(s => memory.delete(s))
    const slotOf = (tabId, key) => `${PREFIX}${tabId}:${key}`
    const known = (tabId, origin, key) =>
        Number.isInteger(tabId) &&
        tabId >= 0 &&
        typeof origin === 'string' &&
        origin.length > 0 &&
        Object.hasOwn(TAB_HANDOFFS, key)

    const put = async (tabId, origin, key, value) => {
        if (!known(tabId, origin, key)) return 'refused'
        const json = JSON.stringify(value ?? null)
        if (bytes(json) > MAX_BYTES) return 'refused'
        await write(slotOf(tabId, key), {
            origin,
            value: JSON.parse(json),
            t: Date.now(),
        })
        return 'saved'
    }

    let chain = Promise.resolve()
    const inOrder = fn => {
        const run = chain.then(fn)
        chain = run.catch(() => {})
        return run
    }
    // The record for this tab and kind, when it was written on this origin.
    // A record from another origin stays where it is: the tab may go back.
    const fresh = async (tabId, origin, key, take) => {
        if (!known(tabId, origin, key)) return null
        const slot = slotOf(tabId, key)
        const e = await read(slot)
        if (!e || e.origin !== origin) return null
        const ok = Date.now() - e.t < TAB_HANDOFFS[key]
        if (take || !ok) await drop([slot])
        return ok ? e.value : null
    }

    return {
        // 'saved', or 'refused' for an unknown kind or a record over 4 kB.
        set: (tabId, origin, key, value) =>
            inOrder(() => put(tabId, origin, key, value)),
        // Writes only over a fresh record of this origin, and, when `expected`
        // is given, only while that record still holds exactly it: 'saved',
        // 'absent' (no record to replace), 'changed' (someone else wrote it
        // first) or 'refused'. Read and write are one step.
        replace: (tabId, origin, key, value, expected) =>
            inOrder(async () => {
                if (!known(tabId, origin, key)) return 'refused'
                const was = await fresh(tabId, origin, key, false)
                if (was === null) return 'absent'
                if (
                    expected !== undefined &&
                    JSON.stringify(was) !== JSON.stringify(expected)
                )
                    return 'changed'
                return put(tabId, origin, key, value)
            }),
        get: (tabId, origin, key) =>
            inOrder(() => fresh(tabId, origin, key, false)),
        // Read and remove: a record is answered once.
        take: (tabId, origin, key) =>
            inOrder(() => fresh(tabId, origin, key, true)),
        // Removes this origin's record; another origin's is left alone.
        clear: (tabId, origin, key) =>
            inOrder(async () => {
                if (!known(tabId, origin, key)) return
                const slot = slotOf(tabId, key)
                if ((await read(slot))?.origin === origin) await drop([slot])
            }),
        forgetTab: tabId =>
            inOrder(async () => {
                if (!Number.isInteger(tabId) || tabId < 0) return
                await drop(Object.keys(TAB_HANDOFFS).map(k => slotOf(tabId, k)))
            }),
    }
}
