import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

// The copy list is sized by the space the card has, not by a number.
//
// It used to be `max-height: 190px`, which is three rows and a bit. So the list
// always ended on a row sliced through the middle, directly under a solid
// button, with no scrollbar visible — Chrome's overlay scrollbars stay hidden
// until you scroll, so nothing on screen said the list continued. A half-drawn
// row with no scrollbar does not read as "scroll for more", it reads as a
// rendering fault. And it was the same three rows on every screen while the
// card was allowed 88dvh: on a 1440×900 desktop the card used 620px of 900 and
// showed three of six codes.
//
// Measured in Chrome via the scratchpad UI harness (2026-08-06), rendering the
// 20-code list — the longest the modal will build (CARAMEL_MANUAL_LIST_MAX) —
// across six viewports from 1440×900 down to 320×480. At every one: the
// primary button and the × stayed fully inside the viewport, the card itself
// did not scroll (one scroll region, not a card scrolling inside a list), and
// the rows on screen scaled with the viewport instead of being pinned at three
// — nine on the desktop, five on a 360×640 phone, three on a 480px-tall
// window, where three is genuinely all that fits.
//
// jsdom has no layout, so none of that can be re-measured here; what this file
// pins is the rule the measurement established, so the fixed cap cannot come
// back silently. `flex: 1 1 auto` needs `min-height: 0` beside it — without it
// a flex item refuses to shrink below its content, the list never scrolls, and
// the button gets pushed off the bottom of the screen.
const HERE = path.dirname(fileURLToPath(import.meta.url))
const CSS_PATH = path.resolve(HERE, '..', 'public', 'assets', 'content-ui.css')

let css

// Declarations of one rule, comments stripped — so a selector named in prose
// is never mistaken for the rule itself.
function ruleBody(selector) {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = withoutComments.match(
        new RegExp(`(^|[},])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm'),
    )
    return match ? match[2] : null
}

beforeAll(() => {
    css = fs.readFileSync(CSS_PATH, 'utf8')
})

describe('the copy list on the final card', () => {
    it('takes the height the card has spare instead of a fixed number of rows', () => {
        const body = ruleBody('.caramel-manual-list')

        expect(body).not.toBeNull()
        expect(body).toMatch(/flex:\s*1\s+1\s+auto/)
        expect(body).not.toMatch(/max-height:\s*\d+px/)
    })

    it('may shrink below its own content, or it would push the button off screen', () => {
        expect(ruleBody('.caramel-manual-list')).toMatch(/min-height:\s*0/)
    })

    it('shows a scrollbar that does not wait for a scroll to appear', () => {
        // The signal that there are more codes below the fold.
        const body = ruleBody('.caramel-manual-list')

        expect(body).toMatch(/overflow-y:\s*auto/)
        expect(body).toMatch(/scrollbar-width:\s*thin/)
    })

    it('sits in a column, which is what gives it a leftover to take', () => {
        // flex:1 means nothing unless the card is the flex container: without
        // this the property is inert and the list falls back to content height.
        const body = ruleBody('.caramel-final-modal')

        expect(body).toMatch(/display:\s*flex/)
        expect(body).toMatch(/flex-direction:\s*column/)
    })

    it('leaves the card as the thing that caps the height', () => {
        // The card still refuses to exceed the viewport; the list scrolls
        // inside it. Losing this would let a 20-code list grow past the screen.
        expect(ruleBody('.caramel-final-modal')).toMatch(/max-height:\s*min\(/)
    })
})
