import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CARAMEL_HOST_CSS } from '../UI-helpers.js'

// Every surface we inject is a shadow HOST: a bare <div> whose children all
// live in a shadow root. In the light DOM — which is the only DOM the store's
// stylesheet can see — that div is EMPTY, and `:empty` is a selector themes
// really use.
//
// 1thrive.com ships this in its reset:
//
//   a:empty, ul:empty, dl:empty, div:empty, section:empty, article:empty,
//   p:empty, h1:empty … { display: none }
//
// Measured 2026-08-06 with the real extension loaded on a seeded cart: the
// prompt injected, computed the right dodge, and rendered 0x0 with
// `display: none`. Every log said it worked. The shopper saw nothing — and the
// same rule takes the testing and final overlays with it, so on a store like
// this the entire flow is invisible from end to end.
//
// One missing declaration voids the product on any such store while looking
// perfectly healthy from the inside, which is exactly the kind of failure that
// never reaches us as a bug report. Hence a pin on every host.

const extensionRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = relPath => readFileSync(join(extensionRoot, relPath), 'utf8')

const HOST_IDS = [
    'caramel-small-prompt',
    'caramel-testing-overlay',
    'caramel-final-overlay',
]

describe('an injected host a store’s CSS cannot switch off', () => {
    it.each(HOST_IDS)(
        '%s declares its own display, inline, where the page cannot outrank it',
        id => {
            const css = CARAMEL_HOST_CSS[id]

            expect(css, `${id} has no inline host CSS at all`).toBeTruthy()
            expect(css).toMatch(/display:\s*block\s*!important/)
        },
    )

    it.each(HOST_IDS)(
        '%s is also covered by the light-DOM backup sheet',
        id => {
            // caramel-content.css is Chrome's copy of the same declarations. It is
            // kept in sync by hand, so it gets the same pin — a fix applied to one
            // and not the other is the failure mode this guards.
            // Comments come out first: the ones explaining this very fix quote a
            // theme's `div:empty { display:none }`, and a naive scan for the next
            // `}` ends inside that quote rather than at the end of the rule.
            const sheet = read('caramel-content.css').replace(
                /\/\*[\s\S]*?\*\//g,
                '',
            )
            const idx = sheet.indexOf(`#${id}`)

            expect(
                idx,
                `${id} is missing from caramel-content.css`,
            ).toBeGreaterThan(-1)
            // The rule body this id belongs to: from the selector to the next `}`.
            const body = sheet.slice(idx, sheet.indexOf('}', idx))
            // Selectors may be grouped, in which case the declarations sit after
            // the last one — look from the id to the end of that block either way.
            expect(body).toMatch(/display:\s*block\s*!important/)
        },
    )

    it('keeps the prompt clickable rather than merely present', () => {
        // display is the one that was measured, but a host that renders and
        // ignores clicks is the same defect wearing a different hat.
        expect(CARAMEL_HOST_CSS['caramel-small-prompt']).toMatch(
            /cursor:\s*pointer/,
        )
        expect(CARAMEL_HOST_CSS['caramel-small-prompt']).toMatch(
            /z-index:\s*2147483646/,
        )
    })
})
