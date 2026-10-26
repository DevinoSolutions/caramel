// Split out of UI-helpers.js (T-5446), moved verbatim: no behavior change.

/* How far down the pill has to start to clear the store's own top bar.
 *
 * It is fixed 20px from the top-right and up to 300px wide — on a phone, most
 * of the header — and QA kept finding it on the store's logo, its nav, or a
 * hand's width from the store's OWN ×. Reading as "part of this website, in the
 * way" is the worst first impression an injected surface can make.
 *
 * Measured, and only ever downward: start below what is up there, and with
 * nothing up there stay exactly where we always were. Split from the DOM probe
 * so the decision is testable without layout, which jsdom has none of.
 */
export const CARAMEL_PROMPT_BASE_TOP = 20
const CARAMEL_PROMPT_MAX_DODGE = 200
export function caramelPromptTopFor(barBottom) {
    const bottom = Number(barBottom)
    if (!Number.isFinite(bottom) || bottom <= CARAMEL_PROMPT_BASE_TOP)
        return CARAMEL_PROMPT_BASE_TOP
    if (bottom > CARAMEL_PROMPT_MAX_DODGE) return CARAMEL_PROMPT_BASE_TOP
    return Math.round(bottom) + 12
}
/* Is this element something we would land on top of?
 *
 * Every clause has a live counterexample (2026-08-06, carts at 1440 and 390);
 * none should go without a fresh one. hidden — allbirds and toms park drawers
 * up here. on-screen — 100percentpure holds panels at top:-300px. width —
 * toms' cookie banner is pinned 90→266 at 45% wide, and reading THAT as a bar
 * blows the budget and drops the pill back onto the header. dodgeable — a bar
 * we cannot clear must not mask one we can; goodr's full-viewport OneTrust
 * scrim fails here, which is why no separate scrim clause exists. The old bug
 * was never that the scrim counted as a bar — it was that the scrim HID one.
 *
 * overlap makes this a collision rule rather than a how-tall-is-the-chrome
 * rule, and it cuts both ways: cultbeauty at 390 pins its header at 120→185,
 * wholly below the pill, and an earlier version of this moved 177px to dodge
 * something it never touched.
 *
 * isBanner admits ONE unpinned element (see _caramelPageBanner) because an
 * unpinned header still collides on arrival, the moment a shopper decides what
 * we are: 100percentpure's static header reaches 121 and the pill sat across
 * its logo and search. Scrolled past, it has a negative rect and drops out.
 *
 * Takes a style and a rect, not an element, so the rule is testable where jsdom
 * has no layout to produce either.
 */
const CARAMEL_BAR_MIN_WIDTH_RATIO = 0.5
// Measured with the real stylesheets: 81px at 1440, 390 and 360 alike — the
// copy is fixed English and does not wrap even on the narrowest phone.
const CARAMEL_PROMPT_HEIGHT = 81
export function _caramelBarQualifies(style, rect, vw, isBanner) {
    if (!style || !rect) return false
    const pinned = style.position === 'fixed' || style.position === 'sticky'
    if (!pinned && !isBanner) return false
    if (style.visibility === 'hidden' || style.display === 'none') return false
    if (Number(style.opacity) === 0) return false
    if (!(rect.height > 0)) return false
    if (!(rect.bottom > CARAMEL_PROMPT_BASE_TOP)) return false
    if (!(rect.top < CARAMEL_PROMPT_BASE_TOP + CARAMEL_PROMPT_HEIGHT))
        return false
    if (rect.bottom > CARAMEL_PROMPT_MAX_DODGE) return false
    if (vw && rect.width < vw * CARAMEL_BAR_MIN_WIDTH_RATIO) return false
    return true
}

/* The one element allowed to count as an UNPINNED top bar.
 *
 * "Any visible <header> near the top" is too generous, and tog24 is why: its
 * cart carries FIVE, one per component (a mini-cart's at 84→160), and honouring
 * the lowest pushed the pill 57px below a header it had already cleared. The
 * spec's rule for when <header> means role="banner" — not inside
 * article/aside/main/nav/section — discards three of the five, but not the
 * mini-cart, which sits in a custom element matching no sectioning selector.
 *
 * Document order separates them: on both stores the page's header is FIRST and
 * every component header follows. So take one candidate and apply the spec rule
 * to it; a store hiding a decorative <header> above its real one yields nothing
 * and falls back to the pinned sweep, which is the conservative direction.
 */
export function _caramelPageBanner() {
    const el = document.querySelector('header, [role="banner"]')
    if (!el) return null
    if (el.parentElement?.closest('article, aside, main, nav, section'))
        return null
    return el
}

/* The bottom edge of the lowest thing we would collide with, or NaN.
 *
 * This hit-tested three points at y=6 until eight live carts (2026-08-06)
 * showed no hit test can work. goodr's cookie scrim is the topmost element, so
 * the probe read ITS 900px bottom and gave up on a header ending at 90 — and
 * reading the whole stack would not have helped, because at y=6 the only bar is
 * a 25px strip and the header we hit is below it. Worse, elementsFromPoint
 * skips `pointer-events:none`, which is how allbirds mounts its nav (0→152).
 *
 * So it enumerates: storefront bars sit near the top of the tree (deepest
 * measured: 3), and a bounded sweep of body's first levels found every one in
 * 0.4–4.6ms. Lowest qualifying bar wins — no contiguity chain, because
 * _caramelBarQualifies rejects strays by shape and the chained version broke
 * toms.
 *
 * Measured through THIS file, not a copy of its logic: goodr 20→102, allbirds
 * 20→164, 1thrive 20→140, 100percentpure 20→133 — four stores where the pill
 * sat on the store's own header. tog24 188, toms 127, cultbeauty 20 unchanged.
 */
const CARAMEL_BAR_SCAN_DEPTH = 4
const CARAMEL_BAR_SCAN_NODES = 400
export function caramelTopBarBottom() {
    try {
        if (!document.body) return NaN
        const vw = window.innerWidth || 0
        let lowest = NaN
        let budget = CARAMEL_BAR_SCAN_NODES
        let level = [document.body]
        for (
            let depth = 0;
            depth <= CARAMEL_BAR_SCAN_DEPTH && budget > 0;
            depth++
        ) {
            const next = []
            for (const parent of level) {
                for (const el of parent.children) {
                    if (budget <= 0) break
                    budget -= 1
                    next.push(el)
                    const rect = el.getBoundingClientRect()
                    const style = getComputedStyle(el)
                    if (!_caramelBarQualifies(style, rect, vw, false)) continue
                    if (!(lowest >= rect.bottom)) lowest = rect.bottom
                }
                if (budget <= 0) break
            }
            level = next
        }
        const banner = _caramelPageBanner()
        if (banner) {
            const rect = banner.getBoundingClientRect()
            if (
                _caramelBarQualifies(
                    getComputedStyle(banner),
                    rect,
                    vw,
                    true,
                ) &&
                !(lowest >= rect.bottom)
            )
                lowest = rect.bottom
        }
        return lowest
    } catch {
        // No layout engine, or a page that blocks the sweep — keep the default.
        return NaN
    }
}
