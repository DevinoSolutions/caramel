import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import {
    caramelBeginRun,
    caramelCancelRun,
    caramelClaimRunHop,
    caramelHandoffMayExist,
    caramelHoldAppliedWin,
    caramelMarkPendingSubmit,
    caramelTakeAppliedWin,
    caramelTakePendingSubmit,
} from '../dom-utils.js'
import { tabHandoffBackground } from './_tab-handoff-background.mjs'

/* A run carries across the store's page loads, so "stop" has to survive one.
 *
 * The × is pressed on a page whose form POST may already be on its way: the
 * shopper pressed Apply, then thought better of it. Whatever the cancel still
 * has to send after that page is gone is never sent, and whatever the background
 * answers it never arrives. The next page then decides, on what reached the
 * background and what this tab's sessionStorage says, whether to submit the
 * next code. It must not.
 *
 * The harness plays the tab: messages the page sends reach the background
 * (tab-handoff.js, the real store), and after navigate() the old page's
 * pending replies are dropped and anything it sends next goes nowhere, until
 * the next page starts (arrive()).
 */
const handoffs = tabHandoffBackground()
let sent
let pageAlive
let interceptReplace

beforeAll(() => {
    globalThis.chrome = {
        runtime: {
            lastError: undefined,
            sendMessage: (message, cb) => {
                if (message?.action !== 'tabHandoff') return cb?.({})
                if (!pageAlive) return // the page that sent it is gone
                sent.push(message)
                const from = pageAlive
                const deliver = async () => {
                    if (message.op === 'replace' && interceptReplace)
                        await interceptReplace(message)
                    const r = await handoffs.reply(message)
                    // The answer reaches only the page that asked.
                    if (pageAlive === from) cb?.(r)
                }
                deliver()
            },
        },
        storage: {
            local: { get: (_k, cb) => cb?.({}), set: (_i, cb) => cb?.() },
            sync: { get: (_k, cb) => cb?.({}), set: (_i, cb) => cb?.() },
        },
    }
    initCaramelBase()
})

beforeEach(() => {
    handoffs.reset()
    sessionStorage.clear()
    sent = []
    pageAlive = {}
    interceptReplace = null
})

const navigate = () => {
    pageAlive = null
}
const arrive = () => {
    pageAlive = {}
}
const settle = () => new Promise(r => setTimeout(r, 0))

describe('a × the store’s navigation cuts short', () => {
    it('still ends the run on the next page', async () => {
        await caramelBeginRun()

        // The shopper presses × as the store's form POST takes the page away.
        caramelCancelRun()
        navigate()
        await settle()

        arrive()
        expect(await caramelClaimRunHop()).toBeNull()
        expect(await handoffs.peek('run')).toBeNull()
    })

    it('is stopped by the stop mark when no message got out', async () => {
        await caramelBeginRun()

        // Nothing the cancel sends reaches the background.
        navigate()
        caramelCancelRun()
        await settle()
        expect(await handoffs.peek('run')).toMatchObject({ hops: 0 })

        arrive()
        expect(await caramelClaimRunHop()).toBeNull()
        expect(await handoffs.peek('run')).toBeNull()
    })

    it('is stopped by the background’s record when the page drops the mark', async () => {
        await caramelBeginRun()
        await caramelCancelRun()

        // The store's own script clears sessionStorage on its way out.
        sessionStorage.removeItem('caramel_run_stop')
        expect(await handoffs.peek('run')).toMatchObject({ cancelled: 1 })
        arrive()
        expect(await caramelClaimRunHop()).toBeNull()
        // No hop was taken over the tombstone.
        expect(
            sent.filter(m => m.op === 'replace' && m.value?.hops === 1),
        ).toEqual([])
    })
})

describe('the hop claim', () => {
    it('loses to a cancel that lands between its read and its write', async () => {
        await caramelBeginRun()
        interceptReplace = async message => {
            if (message.value?.hops !== 1) return
            interceptReplace = null
            await handoffs.reply({
                op: 'replace',
                key: 'run',
                value: { hops: 6, t: 0, cancelled: 1 },
            })
        }

        expect(await caramelClaimRunHop()).toBeNull()
        expect(await handoffs.peek('run')).toMatchObject({ cancelled: 1 })
    })

    it('takes a hop when nothing raced it', async () => {
        await caramelBeginRun()
        expect(await caramelClaimRunHop()).not.toBeNull()
        expect(await handoffs.peek('run')).toMatchObject({ hops: 1 })
    })
})

describe('a stop mark the page writes', () => {
    it('can only stop a run', async () => {
        await caramelBeginRun()
        sessionStorage.setItem('caramel_run_stop', '1')

        expect(await caramelClaimRunHop()).toBeNull()
        expect(await handoffs.peek('run')).toBeNull()
    })

    it('is cleared by the shopper’s next click', async () => {
        sessionStorage.setItem('caramel_run_stop', '1')
        await caramelBeginRun()
        expect(await caramelClaimRunHop()).not.toBeNull()
    })
})

/* Every https page load used to wait on the background twice (pending submit,
 * applied win) before detection could start, up to 3 s each when the
 * background was slow to wake. The tab's sessionStorage now notes which
 * handoffs it MAY have left. That note only decides whether to ask. */
describe('the "a handoff may exist" note', () => {
    const asked = key => sent.filter(m => m.op === 'take' && m.key === key)

    it('lets a page with nothing pending skip the background', async () => {
        expect(await caramelTakePendingSubmit()).toBeNull()
        expect(await caramelTakeAppliedWin()).toBeNull()
        expect(await caramelClaimRunHop()).toBeNull()
        expect(sent).toEqual([])
    })

    it('gives a page that forged it nothing', async () => {
        sessionStorage.setItem(
            'caramel_handoff_hint',
            JSON.stringify(['pending_submit', 'applied', 'run']),
        )

        expect(await caramelTakePendingSubmit()).toBeNull()
        expect(await caramelTakeAppliedWin()).toBeNull()
        expect(await caramelClaimRunHop()).toBeNull()
        // It asked, and the background had nothing for this tab.
        expect(asked('pending_submit')).toHaveLength(1)
        expect(asked('applied')).toHaveLength(1)
    })

    it('is how the next page finds what this one left', async () => {
        await caramelMarkPendingSubmit('SALE20', 'c1', [50])
        await caramelHoldAppliedWin({ code: 'SALE20', id: 'c1', saved: 5 })

        expect(caramelHandoffMayExist('pending_submit')).toBe(true)
        expect(await caramelTakePendingSubmit()).toMatchObject({
            code: 'SALE20',
        })
        expect(await caramelTakeAppliedWin()).toMatchObject({ saved: 5 })
        // Taken: the note goes with the record.
        expect(caramelHandoffMayExist('pending_submit')).toBe(false)
        expect(caramelHandoffMayExist('applied')).toBe(false)
    })

    it('asks anyway when sessionStorage cannot be read', async () => {
        await caramelMarkPendingSubmit('SALE20', 'c1', [50])
        const getItem = Storage.prototype.getItem
        Storage.prototype.getItem = () => {
            throw new Error('SecurityError')
        }
        try {
            expect(await caramelTakePendingSubmit()).toMatchObject({
                code: 'SALE20',
            })
        } finally {
            Storage.prototype.getItem = getItem
        }
    })
})
