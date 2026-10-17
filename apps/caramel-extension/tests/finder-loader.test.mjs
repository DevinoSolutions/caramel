import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    _caramelResetFinderLoad,
    caramelLoadedFinder,
    caramelLoadFinder,
} from '../coupon-box-finder-loader.js'
import { EXT_ROOT } from './_entry-modules.mjs'

// The content script's loader for the promo-box finder. A finder that cannot
// be used is a finder that found nothing (null, never a throw), and a shipped
// build must still be able to see that it happened: log() is silent there,
// so the failure goes through logError, once per page.

const { errors, browser } = vi.hoisted(() => ({
    errors: [],
    browser: { getURL: () => '' },
}))
vi.mock('../caramel-base.js', async importOriginal => {
    const actual = await importOriginal()
    return {
        ...actual,
        get currentBrowser() {
            return { runtime: { getURL: p => browser.getURL(p) } }
        },
        logError: (where, err) =>
            errors.push([where, String(err?.message || err)]),
    }
})

const fixture = name =>
    pathToFileURL(join(EXT_ROOT, 'tests', 'fixtures', 'finder-loader', name))
        .href

beforeEach(() => {
    errors.length = 0
    _caramelResetFinderLoad()
})

describe('the finder loader', () => {
    it('a finder that takes the hand-over is loaded, once, and given the helpers', async () => {
        let asked = 0
        browser.getURL = () => {
            asked++
            return fixture('finder-ok.mjs')
        }
        const m = await caramelLoadFinder()
        await caramelLoadFinder()
        expect(asked).toBe(1)
        expect(caramelLoadedFinder()).toBe(m)
        expect(typeof m.handedOver.log).toBe('function')
        expect(typeof m.handedOver.getPrice).toBe('function')
        expect(errors).toEqual([])
    })

    it('a module with no hand-over is not loaded: null, and the failure is reported', async () => {
        browser.getURL = () => fixture('finder-no-handover.mjs')
        expect(await caramelLoadFinder()).toBeNull()
        expect(caramelLoadedFinder()).toBeNull()
        expect(errors).toEqual([
            ['FINDER_LOAD_FAILED', 'the finder module has no host hand-over'],
        ])
    })

    for (const [name, getURL] of [
        ['a file that is not there', () => fixture('no-such-finder.mjs')],
        [
            'an extension URL that cannot be built',
            () => {
                throw new Error('Extension context invalidated.')
            },
        ],
    ])
        it(`${name}: null, reported once however often the page asks`, async () => {
            browser.getURL = getURL
            const answers = await Promise.all([
                caramelLoadFinder(),
                caramelLoadFinder(),
            ])
            answers.push(await caramelLoadFinder())
            expect(answers).toEqual([null, null, null])
            expect(errors).toHaveLength(1)
            expect(errors[0][0]).toBe('FINDER_LOAD_FAILED')
        })
})
