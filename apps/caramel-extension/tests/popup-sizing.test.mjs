import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Regression pin, 2026-08-04. The popup shipped `body { width: min(420px,
// 100vw) }` and rendered as a narrow black column on a real Chrome install.
//
// A browser-action popup is sized FROM its content, so viewport units are
// circular: Chrome lays out with a tiny initial viewport, `100vw` resolves to
// that, the body shrinks to match, and nothing widens it again. The result is
// a ~35px column between the body's own min-height (320px) and max-height
// (600px), painted with --cm-bg -- which in dark mode is #171210, i.e. a
// plain black rectangle.
//
// This is a STATIC assertion on the stylesheet rather than a rendered-width
// check on purpose: jsdom has no layout engine, so it cannot reproduce the
// circular sizing that causes the bug. What it CAN do is make the specific
// mistake unrepeatable.
const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '..', 'assets', 'styles.css'), 'utf8')

/* The top-level `body { ... }` rule that owns the popup's size.
 *
 * There is more than one body rule -- the `html, body` reset comes first and
 * carries no width -- so select by content rather than by position, or this
 * pin silently asserts against the wrong block. */
function bodyRule() {
    const blocks = []
    const re = /^body\s*\{/gm
    let m
    while ((m = re.exec(css)) !== null) {
        blocks.push(css.slice(m.index, css.indexOf('}', m.index)))
    }
    // Comments are stripped so the rule that DOCUMENTS the banned `100vw`
    // (right above the fix) isn't read as a use of it.
    const declarations = blocks.map(b => b.replace(/\/\*[\s\S]*?\*\//g, ''))
    const sizing = declarations.filter(b => /(^|[\s;{])width:/.test(b))
    expect(sizing, 'exactly one body rule sets the popup width').toHaveLength(1)
    return sizing[0]
}

describe('popup sizing', () => {
    it('gives the body a definite width so Chrome can measure the popup', () => {
        expect(bodyRule()).toMatch(/(^|[\s;{])width:\s*\d+px/)
    })

    it('never sizes the popup body with viewport units', () => {
        // vw/vh/dvw/dvh/svw/lvw are all circular inside a popup. The content
        // scripts DO legitimately use 100vw -- they run in a real page
        // viewport -- so this ban is scoped to the popup body rule alone.
        expect(bodyRule()).not.toMatch(/\d\s*(d|s|l)?v(w|h|min|max)\b/)
    })

    it('caps the coupon list so the card cannot overflow the popup body', () => {
        // The list is the only growable block in the coupons view; everything
        // above it inside body's 600px ceiling — header, profile row, savings
        // banner, list heading — measures ~279px once the user has banked a
        // saving. A 360px cap therefore overflowed by ~39px, and because body
        // is overflow:hidden the last coupon was sliced mid-card with the
        // bottom of the scroll viewport pushed below the popup entirely.
        // Measured live at 320px: card bottom 582.6 vs container 584. The
        // banner was added AFTER the cap was chosen, which is precisely how a
        // number that once fit stopped fitting — so pin the arithmetic.
        const BODY_MAX = 600
        const CHROME_ABOVE_AND_BELOW_LIST = 279
        const m = css.match(/\.coupon-list\s*\{[\s\S]*?\}/)
        expect(m, '.coupon-list rule exists').not.toBeNull()
        const cap = Number(
            m[0]
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .match(/max-height:\s*(\d+)px/)[1],
        )
        expect(cap + CHROME_ABOVE_AND_BELOW_LIST).toBeLessThanOrEqual(BODY_MAX)
    })

    it('still clamps on a narrow host instead of clipping', () => {
        // Firefox's overflow menu is narrower than 420px; max-width resolves
        // against <html>, which is safe, where a vw-based cap is not.
        expect(bodyRule()).toMatch(/max-width:\s*100%/)
    })
})
