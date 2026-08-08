import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadExtensionSources } from './_load.mjs'

// Whether to offer help on a page was decided entirely by "does the config's
// promo selector match something visible here". That asks about our
// configuration, not about what we can actually DO for the shopper.
//
// The 2026-08-05 QA sweep measured the gap: roughly half the catalogue
// (~1,300 stores) carries a coupon selector written against the CHECKOUT, so a
// shopper sitting on the cart page of a store that HAS codes in our database
// got nothing — no pill, no coupon fetch, nothing. On the platforms in
// question, the discount-link path needs no promo box at all and would have
// worked from that very page.
//
// A store that has coupons must be usable. So the gate now also opens on
// capability: a live cart, with something in it, that we can read and drive.

let isCheckout
let probeCalls

const REC = { domain: 'example.com', couponInput: '#promo' }

function setPath(pathname) {
    window.history.replaceState({}, '', pathname)
}

/** jsdom's document.referrer is a getter with no setter. */
function setReferrer(value) {
    Object.defineProperty(document, 'referrer', { value, configurable: true })
}

beforeAll(() => {
    ;({ isCheckout } = loadExtensionSources(
        [
            'coupon-constants.generated.js',
            'caramel-base.js',
            'dom-utils.js',
            'store-detect.js',
            'coupon-apply.js',
            'coupon-fetch.js',
            'coupon-runner.js',
        ],
        ['isCheckout'],
    ))
})

beforeEach(() => {
    document.body.innerHTML = ''
    probeCalls = 0
    setPath('/')
    setReferrer('')
    globalThis.getDomainRecord = async () => REC
    // jsdom has no layout, so the visibility test fails closed for every
    // element — which is exactly the state this gate exists for: no promo box.
    globalThis.waitForElement = async () => {
        throw new Error('not found')
    }
    globalThis.probeCartJson = async () => {
        probeCalls++
        return { token: 't', total_price: 4499, item_count: 2, currency: 'USD' }
    }
})

describe('isCheckout — capability, not just configuration', () => {
    it('helps on a cart page whose promo box lives on the checkout', async () => {
        setPath('/cart')

        expect(await isCheckout()).toBe(true)
    })

    it('recognises the other names stores give that page', async () => {
        for (const path of [
            '/basket',
            '/checkout',
            '/checkouts/c/abc123',
            '/shopping-cart',
            '/en-gb/cart?step=1',
        ]) {
            setPath(path)
            expect(await isCheckout(), path).toBe(true)
        }
    })

    it('stays quiet on a cart the shopper has not filled', async () => {
        setPath('/cart')
        globalThis.probeCartJson = async () => ({
            token: 't',
            total_price: 0,
            item_count: 0,
            currency: 'USD',
        })

        expect(await isCheckout()).toBe(false)
    })

    it('stays quiet where the platform has no cart to read', async () => {
        // Non-Shopify-class store: the probe simply fails, and a page with no
        // promo box and no readable cart is a page we cannot help on.
        setPath('/cart')
        globalThis.probeCartJson = async () => null

        expect(await isCheckout()).toBe(false)
    })

    it('does not turn a product page into a checkout', async () => {
        setPath('/products/leather-satchel')

        expect(await isCheckout()).toBe(false)
    })

    it('leaves the bag CATEGORY alone', async () => {
        // /collections/bag is a category on a great many stores, and a shopper
        // with a full cart browsing handbags is not at a checkout.
        setPath('/collections/bag')

        expect(await isCheckout()).toBe(false)
    })

    it('costs an ordinary page no network request at all', async () => {
        setPath('/products/leather-satchel')

        await isCheckout()

        expect(probeCalls).toBe(0)
    })

    // A store with no config row at all used to return false here without even
    // probing. That was the same mistake this file was written to fix, one
    // level up: "we have no configuration for this host" answered as "there is
    // nothing we can do for this shopper". Sampled against the live catalogue
    // on 2026-08-06, 209 of 573 stores we hold coupons for (36%) have no config
    // row — and on a readable cart the discount-link path needs none of it.
    //
    // What it costs is one same-origin GET of /cart.js on cart-shaped URLs of
    // stores we may not cover. The store already knows the shopper is on its
    // own cart page, and the checks below keep it off every other page.
    describe('a store with no config row of its own', () => {
        beforeEach(() => {
            globalThis.getDomainRecord = async () => null
        })

        it('is helped anyway when its cart is readable and has something in it', async () => {
            setPath('/cart')

            expect(await isCheckout()).toBe(true)
        })

        it('is left alone when the platform has no cart to read', async () => {
            setPath('/cart')
            globalThis.probeCartJson = async () => null

            expect(await isCheckout()).toBe(false)
        })

        it('is left alone when the cart is empty', async () => {
            setPath('/cart')
            globalThis.probeCartJson = async () => ({
                token: 't',
                total_price: 0,
                item_count: 0,
                currency: 'USD',
            })

            expect(await isCheckout()).toBe(false)
        })

        it('costs an ordinary page of it no request at all', async () => {
            // The whole web has product pages. Only cart-shaped URLs may probe.
            setPath('/products/leather-satchel')

            expect(await isCheckout()).toBe(false)
            expect(probeCalls).toBe(0)
        })
    })
})

// A cart-shaped PATH was the only way in, and a growing number of stores no
// longer have one. Measured live on 2026-08-06: allbirds.com answers /cart with
// a 302 to /?openCartDrawer=true, and toms.com navigates /cart to
// /?open_cart=true and then rewrites the address bar to a bare / without a
// second navigation. On both, the shopper is standing in their cart looking at
// a drawer, and the gate stayed shut for the whole visit.
//
// The rules below are URL SHAPES — a query-key pattern, a hash, a referrer
// path. None of them names a store or one store's parameter, which is the line
// the ban above CARAMEL_CART_PATH_RE draws.
describe('isCheckout — cart intent the path does not spell out', () => {
    it('opens on a drawer flag in the query (camelCase key)', async () => {
        setPath('/?openCartDrawer=true')

        expect(await isCheckout()).toBe(true)
    })

    it('opens on the same flag written with an underscore', async () => {
        setPath('/?open_cart=true')

        expect(await isCheckout()).toBe(true)
    })

    it('opens on a cart-shaped hash', async () => {
        setPath('/#/cart')

        expect(await isCheckout()).toBe(true)
    })

    // The verb alternation was written from the two stores in front of us and
    // stopped there. chomps.com and drsquatch.com both answer /cart with a
    // redirect to /?viewcart=true, and "view" is the plainest verb in the set —
    // the one a store reaches for first. chomps has 15 codes in the catalogue
    // and showed the shopper nothing on its own cart page.
    it('opens on a "view" verb, run together with the noun', async () => {
        setPath('/?viewcart=true')

        expect(await isCheckout()).toBe(true)
    })

    it('opens on the separated spellings of that same verb', async () => {
        for (const url of ['/?view-cart=1', '/?view_basket=true']) {
            setPath(url)
            expect(await isCheckout(), url).toBe(true)
        }
    })

    it('stays shut when the flag is switched OFF', async () => {
        // `?cart=false` / `?open_cart=0` is the store telling us the drawer is
        // closed. Reading the key and ignoring its value would invert that.
        for (const url of [
            '/?cart=false',
            '/?open_cart=0',
            '/?cart=',
            '/?viewcart=false',
        ]) {
            setPath(url)
            expect(await isCheckout(), url).toBe(false)
            expect(probeCalls, url).toBe(0)
        }
    })

    it('leaves a bare home page alone', async () => {
        setPath('/')

        expect(await isCheckout()).toBe(false)
        expect(probeCalls).toBe(0)
    })

    it('does not read a product SLUG as a cart', async () => {
        setPath('/products/cart-organizer')

        expect(await isCheckout()).toBe(false)
        expect(probeCalls).toBe(0)
    })

    describe('the store bounced the shopper off its own cart URL', () => {
        it('opens on a site root reached from this store’s cart', async () => {
            // toms.com's landed page keeps document.referrer = .../cart even
            // after the query flag has been rewritten away.
            setReferrer(location.origin + '/cart')
            setPath('/')

            expect(await isCheckout()).toBe(true)
        })

        it('opens the same way on a locale root', async () => {
            setReferrer(location.origin + '/cart')
            setPath('/en-gb/')

            expect(await isCheckout()).toBe(true)
        })

        // The most important pin in this file. A referrer says where the
        // shopper CAME from, not where they are: leaving the cart to browse a
        // product is the single most ordinary move on any store, and if that
        // opened the gate the prompt would follow shoppers around the site.
        it('stays shut when they navigated cart → product page', async () => {
            setReferrer(location.origin + '/cart')
            setPath('/products/leather-satchel')

            expect(await isCheckout()).toBe(false)
            expect(probeCalls).toBe(0)
        })

        it('stays shut for a cart URL on somebody else’s origin', async () => {
            setReferrer('https://other-store.example/cart')
            setPath('/')

            expect(await isCheckout()).toBe(false)
            expect(probeCalls).toBe(0)
        })
    })
})
