import { describe, expect, it } from 'vitest'
import { CARAMEL_UI_FALLBACK_CSS } from '../ui-shell.js'

// Every content surface (prompt, testing modal, final modal) draws the logo PNG
// with no size of its own: content-ui.css sizes it. When that stylesheet loses
// its 4s race, the shadow root gets CARAMEL_UI_FALLBACK_CSS instead, and an
// unsized <img> renders at the PNG's natural size.
//
// Measured 2026-10-28 with the released 1.4.25 build on scosche.com's Shopify
// checkout: HONEY20 applied ($79.98 -> $64.00), the checkout re-rendered, the
// final modal fell back, and its logo filled the window, pushing "You saved
// $15.98" out of view. The fallback must size images itself.
describe('the fallback stylesheet', () => {
    it('gives every image inside our shadow root a small fixed size', () => {
        const rule = CARAMEL_UI_FALLBACK_CSS.match(/(?:^|\})img\{([^}]*)\}/)
        expect(rule, 'no `img{...}` rule in the fallback CSS').not.toBeNull()
        const width = Number(rule[1].match(/(?:^|;)width:(\d+)px/)?.[1])
        const height = Number(rule[1].match(/(?:^|;)height:(\d+)px/)?.[1])
        expect(width).toBeGreaterThan(0)
        expect(width).toBeLessThanOrEqual(48)
        expect(height).toBeGreaterThan(0)
        expect(height).toBeLessThanOrEqual(48)
    })

    it('still styles the three surfaces it always did', () => {
        for (const sel of [
            '.cm-scrim{',
            '.caramel-final-modal{',
            '.cm-prompt{',
        ])
            expect(CARAMEL_UI_FALLBACK_CSS).toContain(sel)
    })
})
