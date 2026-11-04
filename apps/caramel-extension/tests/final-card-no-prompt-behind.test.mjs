import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import {
    insertCaramelPrompt,
    showFinalModal,
    showTestingModal,
} from '../UI-helpers.js'

// Seen live on bumbleandbumble.com with the Edge store build of 1.4.19
// (2026-10-26): a run applied TEXT15, and the savings card came up with the
// "Try Caramel Coupons" pill back on the page behind it.
//
// The card took the testing overlay down FIRST and only then awaited the
// session and its shadow host. For that whole wait none of our overlays was on
// the page, the store re-drew its cart around the accepted code, and the
// checkout observer — which stands down only while one of our overlays is up —
// offered the pill again. These pin both halves of the fix: the overlay stays
// up until the card mounts, and the pill never mounts while a run's surface is
// up, however late its own awaits finish.

const EXT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const stubs = vi.hoisted(() => ({ failHost: null }))

vi.mock('../coupon-runner.js', async importOriginal => ({
    ...(await importOriginal()),
    startApplyingCoupons: async () => {},
}))
vi.mock('../ui-shell.js', async importOriginal => {
    const real = await importOriginal()
    return {
        ...real,
        createCaramelShadowHost: id =>
            id === stubs.failHost
                ? Promise.reject(new Error(`no shadow host for ${id}`))
                : real.createCaramelShadowHost(id),
    }
})

// A storage area whose reads can be held open, standing in for a slow
// extension storage call — the await the card and the prompt both make.
function heldArea() {
    const data = {}
    let held = null
    return {
        data,
        reset() {
            held = null
            for (const key of Object.keys(data)) delete data[key]
        },
        hold() {
            let release
            held = new Promise(r => {
                release = r
            })
            return () => {
                held = null
                release()
            }
        },
        area: {
            get: (_keys, cb) => {
                const answer = () => cb?.({ ...data })
                if (held) held.then(answer)
                else answer()
            },
            set: (items, cb) => {
                Object.assign(data, items)
                cb?.()
            },
            remove: (keys, cb) => {
                for (const key of [].concat(keys)) delete data[key]
                cb?.()
            },
        },
    }
}

const local = heldArea() // the session read (showFinalModal)
const sync = heldArea() // the settings read (insertCaramelPrompt)

const overlay = () => document.getElementById('caramel-testing-overlay')
const card = () => document.getElementById('caramel-final-overlay')
const pill = () => document.getElementById('caramel-small-prompt')
const settle = () => new Promise(r => setTimeout(r, 0))

beforeAll(() => {
    globalThis.chrome = {
        runtime: {
            getURL: p => p,
            lastError: undefined,
            sendMessage: () => {},
        },
        storage: { local: local.area, sync: sync.area },
    }
    initCaramelBase()
    globalThis.fetch = async relPath => ({
        ok: true,
        text: async () =>
            readFileSync(join(EXT_ROOT, 'public', relPath), 'utf8'),
    })
})

beforeEach(() => {
    document.body.innerHTML = ''
    sessionStorage.clear()
    stubs.failHost = null
})

afterEach(() => {
    local.reset()
    sync.reset()
})

describe('the savings card and the pill — a run ends with the card alone', () => {
    it('keeps the testing overlay up until the savings card is on the page', async () => {
        await showTestingModal()
        const release = local.hold()

        const shown = showFinalModal(5.4, 'TEXT15')
        await settle()
        expect(overlay()).not.toBeNull()
        expect(card()).toBeNull()

        release()
        await shown
        expect(overlay()).toBeNull()
        expect(card()).not.toBeNull()
    })

    it('a cart re-draw while the card is being built cannot put the pill behind it', async () => {
        await showTestingModal()
        const release = local.hold()
        const shown = showFinalModal(5.4, 'TEXT15')
        await settle()

        // What the checkout observer does when the store re-draws its cart.
        await insertCaramelPrompt({ domain: 'bumbleandbumble.com' })
        release()
        await shown

        expect(card()).not.toBeNull()
        expect(pill()).toBeNull()
    })

    it('a pill already on its way when the card mounts does not mount behind it', async () => {
        // The pill passed its first check (nothing of ours was up) and is
        // waiting on the settings read when the card goes up. Signed in, so
        // the card's session read never falls back to the held sync area.
        local.data.token = 'session-token'
        const releaseSettings = sync.hold()
        const offered = insertCaramelPrompt({ domain: 'bumbleandbumble.com' })
        await settle()

        await showFinalModal(5.4, 'TEXT15')
        releaseSettings()
        await offered

        expect(card()).not.toBeNull()
        expect(pill()).toBeNull()
    })

    it('offers no pill while a run is on screen', async () => {
        await showTestingModal()
        await insertCaramelPrompt({ domain: 'bumbleandbumble.com' })
        expect(pill()).toBeNull()
    })

    it('offers no pill over a result card', async () => {
        await showFinalModal(5.4, 'TEXT15')
        await insertCaramelPrompt({ domain: 'bumbleandbumble.com' })
        expect(pill()).toBeNull()
    })

    it('still offers the pill on a page with no run on it', async () => {
        await insertCaramelPrompt({ domain: 'bumbleandbumble.com' })
        expect(pill()).not.toBeNull()
    })

    it('a card that fails to build still takes the testing overlay down', async () => {
        await showTestingModal()
        stubs.failHost = 'caramel-final-overlay'

        await expect(showFinalModal(5.4, 'TEXT15')).rejects.toThrow(
            'no shadow host for caramel-final-overlay',
        )

        expect(overlay()).toBeNull()
        expect(card()).toBeNull()
    })
})
