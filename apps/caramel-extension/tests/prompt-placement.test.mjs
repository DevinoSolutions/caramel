import { describe, expect, it } from 'vitest'
import {
    _caramelBarQualifies,
    _caramelPageBanner,
    _caramelUsableTitle,
    caramelPromptTopFor,
    caramelTopBarBottom,
} from '../UI-helpers.js'

// The prompt is fixed 20px from the top-right and up to 300px wide, which on a
// phone is most of the header. QA's first-time users kept meeting the
// consequences rather than the product:
//
//   allbirds.com at 390px — sat on the logo
//   cultbeauty.co.uk      — sat on "Earn Cult Status Points"
//   motoin.de             — landed ~20px from the store's OWN ×, so neither
//                           close button could be told from the other
//
// Reading as "part of this website, in the way" is the worst first impression an
// injected surface can make. So it starts below whatever the store has pinned
// across the top — measured, not assumed, and only ever downward: with nothing
// pinned there, the position is bit-for-bit what it always was.
//
// The decision is split from the DOM probe because jsdom has no layout, so what
// is pinned where cannot be measured in a unit test — but what to DO about a
// measurement can be, and that is the part with a rule in it.

describe('clearing the store’s own top bar', () => {
    it('starts below a typical sticky header', () => {
        expect(caramelPromptTopFor(64)).toBe(76)
    })

    it('clears an announcement bar stacked on a nav', () => {
        expect(caramelPromptTopFor(112)).toBe(124)
    })

    it('changes nothing when the store has pinned nothing', () => {
        expect(caramelPromptTopFor(NaN)).toBe(20)
        expect(caramelPromptTopFor(undefined)).toBe(20)
        expect(caramelPromptTopFor(null)).toBe(20)
    })

    it('changes nothing for a bar that ends above where we already start', () => {
        // A 12px-tall ribbon is already clear of a 20px offset — moving would
        // be motion for its own sake.
        expect(caramelPromptTopFor(12)).toBe(20)
        expect(caramelPromptTopFor(0)).toBe(20)
    })

    it('refuses to dodge something so tall it would push us off screen', () => {
        // A full-height fixed overlay (a nav drawer, a cookie wall) is not a
        // header, and starting 400px down would hide the prompt entirely.
        expect(caramelPromptTopFor(400)).toBe(20)
    })

    it('never moves upward, into the browser chrome', () => {
        expect(caramelPromptTopFor(-50)).toBe(20)
    })
})

// Which elements COUNT as that top bar is the half the rule above cannot see,
// and on 2026-08-06 it was measured on eight live carts at 1440 and 390 —
// because the first version of it, written from the same three stores quoted
// above, turned out never to have worked on any of them. cultbeauty.co.uk still
// scored the untouched 20.
//
// Each fixture below is a real element off a real store that day, kept in its
// measured numbers so a later edit that "simplifies" a clause away has to argue
// with a page rather than with a preference.
const VIEWPORT_WIDTH = 1440
const el = ({
    top,
    bottom,
    width = 1425,
    position = 'fixed',
    visibility = 'visible',
    display = 'block',
    opacity = '1',
    isBanner = false,
}) => [
    { position, visibility, display, opacity },
    { top, bottom, width, height: bottom - top },
    VIEWPORT_WIDTH,
    isBanner,
]

describe('what counts as the store’s top bar', () => {
    it('counts a header pinned below an announcement bar', () => {
        // goodr.com: announcement 0→25, site-header 25→90. The header is the
        // one we collide with and the one a y=6 probe can never see.
        expect(_caramelBarQualifies(...el({ top: 0, bottom: 25 }))).toBe(true)
        expect(_caramelBarQualifies(...el({ top: 25, bottom: 90 }))).toBe(true)
    })

    it('sees the header through the cookie scrim covering it', () => {
        // goodr's OneTrust dark filter is fixed, full width and 900px tall, and
        // it sits OVER the header. It fails on the dodge budget like any other
        // unclearable thing — no special scrim rule — and the header behind it
        // still counts, which is the half the old point probe could not do.
        expect(_caramelBarQualifies(...el({ top: 0, bottom: 900 }))).toBe(false)
        expect(_caramelBarQualifies(...el({ top: 25, bottom: 90 }))).toBe(true)
    })

    it('does not mistake a floating cookie banner for a bar', () => {
        // toms.com: pinned 90→266 and 45% of the width. This is the fixture
        // that killed the contiguous-band version — it chained off the
        // header's bottom, blew the 200px budget, and put the prompt back at
        // 20 on a store the OLD code had got right.
        expect(
            _caramelBarQualifies(...el({ top: 90, bottom: 266, width: 648 })),
        ).toBe(false)
    })

    it('ignores a narrow pinned widget even where we could dodge it', () => {
        // Width is a rule about shape, not a proxy for the height budget: a
        // chat bubble or a floating badge is not a bar at any size.
        expect(
            _caramelBarQualifies(...el({ top: 0, bottom: 60, width: 300 })),
        ).toBe(false)
    })

    it('ignores drawers parked behind the page', () => {
        // toms keeps a cart-drawer overlay pinned and hidden; allbirds parks
        // nav panels the same way.
        expect(
            _caramelBarQualifies(
                ...el({ top: 0, bottom: 900, visibility: 'hidden' }),
            ),
        ).toBe(false)
        expect(
            _caramelBarQualifies(...el({ top: 0, bottom: 60, opacity: '0' })),
        ).toBe(false)
    })

    it('ignores a panel parked off the top of the screen', () => {
        // 100percentpure.com holds three of these at top:-300px.
        expect(_caramelBarQualifies(...el({ top: -300, bottom: -137 }))).toBe(
            false,
        )
    })

    it('counts a floating nav no hit test can reach', () => {
        // allbirds.com wraps its nav in a `pointer-events:none` container at
        // 0→152, which elementsFromPoint skips by specification. Enumerating
        // the tree is the only way to see it — so nothing here may become a
        // hit test again.
        expect(
            _caramelBarQualifies(...el({ top: 0, bottom: 152, width: 1397 })),
        ).toBe(true)
    })

    it('ignores a bar too tall to dodge, so it cannot mask one we can', () => {
        expect(_caramelBarQualifies(...el({ top: 0, bottom: 260 }))).toBe(false)
    })

    it('ignores unpinned page content, which is most of a cart page', () => {
        for (const position of ['static', 'relative', 'absolute']) {
            expect(
                _caramelBarQualifies(...el({ top: 0, bottom: 90, position })),
            ).toBe(false)
        }
    })

    it('counts an unpinned header, because we still land on it on arrival', () => {
        // 100percentpure.com: a static <header> at 56→121 that the pill sat
        // across — its logo and its search box. It scrolls away later; the
        // moment that decides what a shopper thinks of us is before that.
        expect(
            _caramelBarQualifies(
                ...el({
                    top: 56,
                    bottom: 121,
                    position: 'static',
                    isBanner: true,
                }),
            ),
        ).toBe(true)
    })

    it('leaves a bar sitting below the pill alone', () => {
        // cultbeauty.co.uk at 390 pins its header at 120→185. The pill occupies
        // 20→101 and never reaches it, and an earlier version of this function
        // moved anyway — 177px down the page, to dodge something it was not
        // touching. Overlap is the whole question.
        expect(_caramelBarQualifies(...el({ top: 120, bottom: 185 }))).toBe(
            false,
        )
        expect(
            _caramelBarQualifies(
                ...el({
                    top: 120,
                    bottom: 185,
                    position: 'static',
                    isBanner: true,
                }),
            ),
        ).toBe(false)
    })

    it('leaves a ribbon that ends above the pill alone', () => {
        // A 14px announcement strip is already clear of a 20px offset.
        expect(_caramelBarQualifies(...el({ top: 0, bottom: 14 }))).toBe(false)
    })

    it('leaves the position untouched where there is no layout to measure', () => {
        // jsdom has none, and neither does a page that blocks the sweep. The
        // guarantee is that the fallback is the ORIGINAL placement, not a
        // half-computed one.
        expect(caramelPromptTopFor(caramelTopBarBottom())).toBe(20)
    })
})

// Which <header> is THE header is a DOM question, not a layout one, so unlike
// everything above it can be asked of jsdom directly.
const html = markup => {
    document.body.innerHTML = markup
    return _caramelPageBanner()
}

describe('picking the page’s own header out of a page full of headers', () => {
    it('takes the store header even with component headers behind it', () => {
        // tog24.com's cart page carries five <header> elements. The first is
        // the store's; the rest belong to a mini-cart, a form and a modal, and
        // honouring the lowest of them moved the pill 57px for nothing.
        const found = html(`
            <header class="c-header">store</header>
            <div class="shopify-section"><mini-cart><header class="c-model__header">cart</header></mini-cart></div>
            <aside class="c-model"><header class="c-model__header">modal</header></aside>
        `)
        expect(found?.className).toBe('c-header')
    })

    it('accepts an explicit role=banner', () => {
        expect(html('<div role="banner" id="b">x</div>')?.id).toBe('b')
    })

    it('declines when the first one is inside a sectioning element', () => {
        // The spec's own rule for when <header> means role=banner. Finding
        // nothing costs us a dodge; guessing wrong moves the pill onto a
        // shopper's cart.
        for (const wrapper of ['article', 'aside', 'main', 'nav', 'section']) {
            expect(
                html(`<${wrapper}><header>inner</header></${wrapper}>`),
            ).toBeNull()
        }
    })

    it('declines when the page has no header at all', () => {
        expect(html('<div><p>just a cart</p></div>')).toBeNull()
    })
})

describe('a title that is really just the label again', () => {
    // cottonon.com shipped a list whose every title was the literal word
    // "CODE" — a second copy of what the row is already headed by, occupying
    // the line where the discount should be.
    it('drops the placeholder headings scrapers pick up', () => {
        expect(_caramelUsableTitle('CODE')).toBe('')
        expect(_caramelUsableTitle('Coupon Code')).toBe('')
        expect(_caramelUsableTitle('promo code')).toBe('')
        expect(_caramelUsableTitle('Discount Codes')).toBe('')
    })

    it('drops a title that only repeats the code', () => {
        expect(_caramelUsableTitle('SAVE20', 'save20')).toBe('')
        expect(_caramelUsableTitle(' SAVE20 ', 'SAVE20')).toBe('')
    })

    it('keeps a real offer, including one that names its own code', () => {
        expect(_caramelUsableTitle('20% off with SAVE20', 'SAVE20')).toBe(
            '20% off with SAVE20',
        )
        expect(_caramelUsableTitle('Free shipping')).toBe('Free shipping')
        expect(_caramelUsableTitle('Code for 15% off')).toBe('Code for 15% off')
    })

    it('drops a claim whose amount fell out of the scrape', () => {
        // 100percentpure.com, live catalogue 2026-08-06: LASHES arrives as
        // "Get off with code". The shopper is promised nothing and shown a
        // sentence that reads like a bug; the bare code is more honest.
        expect(_caramelUsableTitle('Get off with code', 'LASHES')).toBe('')
        expect(_caramelUsableTitle('Save off your order')).toBe('')
        expect(_caramelUsableTitle('Take off at checkout')).toBe('')
    })

    it('keeps every offer that still has its number', () => {
        // The same store's other 19 titles, and the shapes most like the one
        // above — a rule that also ate these would cost more than it saves.
        for (const good of [
            'Take 15% Off Your Order',
            'Get 50% Off Your Order with Coupon',
            'Get $10 off your first purchase',
            'Buy 3 Get 1 Free with Pure Coupon',
            'Free shipping',
            'Get Coffee Bean Caffeine Restorative Moisturizer for $25',
        ]) {
            expect(_caramelUsableTitle(good)).toBe(good)
        }
    })

    it('still drops the zero-value claims it always did', () => {
        expect(_caramelUsableTitle('Score 0% off with coupon code')).toBe('')
        expect(_caramelUsableTitle('$0.00 off')).toBe('')
    })
})
