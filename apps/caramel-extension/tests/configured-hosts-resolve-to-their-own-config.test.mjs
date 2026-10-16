import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { getDomainRecord } from '../store-detect.js'

// Which config a host gets, checked against the REAL supported-stores list
// (tests/fixtures/supported-store-domains-2026-10-16.json, every domain the
// production endpoint served that day, in its order).
//
// Two things ride on this lookup:
//   · the promo-box finder and the server's pick run only where it answers
//     "no config" (store-detect.js isCheckout, the `!rec` branch). A host of a
//     configured store that the lookup misses is handed to the finder as if
//     nobody had ever written its config;
//   · the record it returns decides whose selectors are driven and whose codes
//     are fetched. A host that resolves to ANOTHER store's row gets that
//     store's codes.

const FIXTURE = JSON.parse(
    readFileSync(
        resolve(
            import.meta.dirname,
            'fixtures/supported-store-domains-2026-10-16.json',
        ),
        'utf8',
    ),
)
const DOMAINS = FIXTURE.domains
const ROWS = DOMAINS.map(domain => ({ domain, couponInput: '#c' }))
// Each whole-list test runs thousands of lookups over the whole list.
const WHOLE_LIST = { timeout: 60_000 }
const lc = s => s.toLowerCase()
const bare = d => lc(d).replace(/^www\./, '')

beforeAll(() => {
    const stub = {
        storage: {
            local: { get: (_k, cb) => cb({}), set: () => {} },
            sync: { get: (_k, cb) => cb({}), set: () => {} },
            session: { get: (_k, cb) => cb({}), set: () => {} },
        },
        runtime: {
            lastError: undefined,
            getURL: p => 'chrome-extension://caramel/' + p,
            sendMessage: (message, cb) =>
                cb(
                    message?.action === 'fetchSupportedStores'
                        ? { supported: ROWS }
                        : {},
                ),
        },
    }
    globalThis.chrome = stub
    window.chrome = stub
    globalThis.browser = undefined
    window.browser = undefined
    initCaramelBase()
})

beforeEach(() => {
    getDomainRecord.cache = null
})

const lookup = async host => (await getDomainRecord(host))?.domain ?? null

describe('the fixture is the real list', () => {
    it('is big enough to mean something and has no blank rows', () => {
        expect(DOMAINS.length).toBeGreaterThan(3000)
        expect(DOMAINS.every(d => typeof d === 'string' && d.trim())).toBe(true)
    })
})

describe('no configured store is mistaken for one with no config', () => {
    it(
        'every configured domain resolves to a config on its own host',
        WHOLE_LIST,
        async () => {
            const missed = []
            for (const d of DOMAINS) if (!(await lookup(lc(d)))) missed.push(d)
            expect(missed).toEqual([])
        },
    )

    it(
        '…and on its www. and checkout. hosts too, including the stores whose row was written with www.',
        WHOLE_LIST,
        async () => {
            // baabuk.com, stuckonyou.com and usa.canon.com have only a www. row.
            // That row describes the store, so their bare and checkout. hosts
            // get it too.
            const missed = []
            for (const d of DOMAINS)
                for (const host of [
                    bare(d),
                    'www.' + bare(d),
                    'checkout.' + bare(d),
                ])
                    if (!(await lookup(host))) missed.push(host)
            expect(missed).toEqual([])
        },
    )

    it('a www.-only row is matched the way a bare row is', async () => {
        for (const host of [
            'baabuk.com',
            'www.baabuk.com',
            'checkout.baabuk.com',
            'usa.canon.com',
            'checkout.usa.canon.com',
        ])
            expect(lc(await lookup(host))).toBe(
                'www.' + host.replace(/^(www|checkout)\./, ''),
            )
        // The boundary still holds: no other store inherits it.
        expect(await lookup('notbaabuk.com')).toBeNull()
        expect(await lookup('evil-baabuk.com')).toBeNull()
    })

    it('upper-case rows in the list still match the lower-case host', async () => {
        const upper = DOMAINS.filter(d => d !== lc(d))
        expect(upper.length).toBeGreaterThan(0)
        for (const d of upper) expect(lc(await lookup(lc(d)))).toBe(lc(d))
    })
})

describe("a host gets its OWN row, never a parent store's", () => {
    // oldnavy.gap.com and gap.com are both rows. A first-match scan in list
    // order handed Old Navy's cart Gap's row (Gap's codes, Gap's selectors),
    // because gap.com is served first. 31 configured stores in this list were
    // shadowed by a parent store that way.
    //
    // A store listed twice, as x.com and as www.x.com, is one store: which of
    // its two rows a host gets stays decided by list order, exactly as
    // before. (Measured on www.billabong.com's checkout, 2026-10-16: its
    // www. row names input[name="reductions[0]"], which is not on the page;
    // the earlier bare row names the field that is.)
    const twinOf = d => {
        const b = bare(d)
        return lc(d) !== b &&
            DOMAINS.findIndex(x => lc(x) === b) <
                DOMAINS.findIndex(x => lc(x) === lc(d))
            ? b
            : null
    }

    it(
        'every configured domain resolves to its own row, or to its earlier bare twin',
        WHOLE_LIST,
        async () => {
            const wrong = []
            let twins = 0
            for (const d of DOMAINS) {
                const got = lc(await lookup(lc(d)))
                const twin = twinOf(d)
                if (twin && got === twin) twins++
                else if (got !== lc(d)) wrong.push(`${d} -> ${got}`)
            }
            expect(wrong).toEqual([])
            expect(twins).toBe(31)
        },
    )

    it('the measured cases', async () => {
        expect(await lookup('oldnavy.gap.com')).toBe('oldnavy.gap.com')
        expect(await lookup('www.oldnavy.gap.com')).toBe('oldnavy.gap.com')
        expect(await lookup('ca.allsaints.com')).toBe('ca.allsaints.com')
        expect(await lookup('outlet.lenovo.com')).toBe('outlet.lenovo.com')
        // The parent keeps its own row.
        expect(await lookup('www.gap.com')).toBe('gap.com')
        // A store with a bare and a www. row: list order, as before.
        expect(await lookup('www.billabong.com')).toBe('billabong.com')
        expect(await lookup('billabong.com')).toBe('billabong.com')
        expect(await lookup('checkout.billabong.com')).toBe('billabong.com')
    })

    it('a hyphen checkout host follows the most specific store too', async () => {
        expect(await lookup('secure-bananarepublic.gap.com')).toBe(
            'bananarepublic.gap.com',
        )
    })
})

describe('a <shop>.myshopify.com host keeps the row it had before', () => {
    // Such a host is matched only by its shop label, which equals the first
    // label of every row of that brand: princesspolly.com and
    // princesspolly.com.au both name the shop `princesspolly`. Ranking those
    // by length picked a row by its country suffix (princesspolly.myshopify.com
    // went to the .com.au row, athleta to athleta.gapcanada.ca), so these
    // hosts keep the earliest such row in list order, as before. A www. row
    // names no shop, as before.
    const beforeRow = shop =>
        DOMAINS.find(d => lc(d).split('.')[0] === shop && shop !== 'www') ??
        null

    it('the list has no myshopify row of its own, so the label is the only match', () => {
        expect(DOMAINS.filter(d => lc(d).includes('myshopify'))).toEqual([])
    })

    it(
        "every row's <label>.myshopify.com resolves as before",
        WHOLE_LIST,
        async () => {
            const shops = new Set()
            for (const d of DOMAINS) {
                shops.add(lc(d).split('.')[0])
                shops.add(bare(d).split('.')[0])
            }
            const changed = []
            for (const shop of shops) {
                const was = beforeRow(shop)
                const now = await lookup(shop + '.myshopify.com')
                if (lc(String(now)) !== lc(String(was)))
                    changed.push(`${shop}.myshopify.com ${was} -> ${now}`)
            }
            expect(shops.size).toBeGreaterThan(2500)
            expect(changed).toEqual([])
        },
    )

    it('the measured cases', async () => {
        expect(await lookup('princesspolly.myshopify.com')).toBe(
            beforeRow('princesspolly'),
        )
        expect(await lookup('athleta.myshopify.com')).toBe(beforeRow('athleta'))
        // Not www.usa.canon.com: a www. row names no shop. Its earliest bare
        // `usa.` row keeps it, as before.
        expect(await lookup('usa.myshopify.com')).toBe(beforeRow('usa'))
        expect(beforeRow('usa')).not.toBe('www.usa.canon.com')
        expect(await lookup('www.myshopify.com')).toBeNull()
        // A real host of the brand still outranks the label match.
        expect(await lookup('www.princesspolly.com.au')).toBe(
            'princesspolly.com.au',
        )
    })
})

describe('a hyphen host of a store under a two-label suffix is another domain', () => {
    // A row x.co.uk or www.x.co.uk is the registrable domain itself, so
    // secure-x.co.uk is a different domain that anyone can register: it gets
    // no config. secure-<store>.<brand>.<tld> hosts are untouched.
    const UNDER = /\.(?:co|com|net|org|me|ac|ne)\.[a-z]{2}$/

    it(
        "no store's hyphen host under such a suffix inherits its config",
        WHOLE_LIST,
        async () => {
            const inherited = []
            for (const d of DOMAINS) {
                const b = bare(d)
                if (!UNDER.test(b) || b.split('.').length !== 3) continue
                for (const p of [
                    'secure',
                    'checkout',
                    'www',
                    'shop',
                    'store',
                ]) {
                    const got = await lookup(`${p}-${b}`)
                    if (got) inherited.push(`${p}-${b} -> ${got}`)
                }
            }
            expect(inherited).toEqual([])
        },
    )

    it('the measured cases', async () => {
        expect(await lookup('secure-emmabridgewater.co.uk')).toBeNull()
        expect(await lookup('shop-shavershop.com.au')).toBeNull()
        expect(await lookup('checkout.emmabridgewater.co.uk')).toBe(
            'emmabridgewater.co.uk',
        )
        expect(await lookup('secure-bananarepublic.gap.com')).toBe(
            'bananarepublic.gap.com',
        )
    })
})
