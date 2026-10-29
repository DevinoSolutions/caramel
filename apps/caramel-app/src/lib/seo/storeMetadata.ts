// The /coupons/<store> page's <title>, meta description and display name.
//
// WHY THIS EXISTS. Search Console, 28 days to 2026-10-13: /coupons/coursera.org
// took 27.4k impressions at an average position of 4.6 and earned no clicks.
// /coupons/anthropologie.com (6.8k, position 4.8), groupon.com (6.3k, 3.2) and
// tradeinn.com (5.8k, 3.5) did the same: top-5 positions, zero clicks. The
// queries are "<brand> promo code" / "coupon code" / "discount code"
// ("coursera discount code" 711, "coursera promo code" 478, "coursera coupon"
// 439), and the old title answered them with a lowercase domain and a
// sentence: "coursera.org coupons & promo codes — 22 active codes | Caramel".
// The result next to it reads "Coursera Promo Code: ...". The snippet now
// leads with the brand, names the three words people search, and states what
// the page actually holds.
//
// CLAIM INTEGRITY (same rule as storeFaq.ts): every number comes from the
// catalog read the page already makes. The display name is the store's own
// domain label, title-cased (coursera.org -> "Coursera"), or a brand spelling
// from the short list below; nothing else about the store is said. The month
// is the month the store's list was last updated (its newest updated_at, the
// date the FAQ prints), and it appears only while that month is the current
// one: a title never dates a list to a month it was not updated in.
import type { StoreCouponFacts } from '@/lib/couponsRepo'
import { storeIntentPilotFor } from '@/lib/seo/storeIntentPilot'
import { parse } from 'tldts'

// Google cuts titles at about 600px (roughly 60 characters) and descriptions
// at about 155-160 characters. The builders pick the longest candidate that
// fits, so nothing is cut mid-word in the result.
const TITLE_MAX = 60
const DESCRIPTION_MAX = 155
const SITE_SUFFIX = ' | Caramel'
// A title calls the listed codes "Active" only while the store's list was
// updated within this window. The count itself is always the live count the
// page lists; "Active" is a freshness claim, and a list nobody has touched
// since August (coursera.org, 2026-10-16) cannot back it.
const ACTIVE_CLAIM_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

// Brand spellings a title-cased domain label gets wrong, for stores with
// Search Console impressions (or a home-page card). Keyed by the label in
// front of the public suffix, so eharmony.ca and eharmony.com share one entry.
//
// A spelling only re-cases, re-spaces or re-punctuates the label (an "&" may
// stand for "and"): it never renames the store, so getbioma.com stays
// "Getbioma" even though the site calls itself Bioma. The 2026-10-16 sweep
// covered the top 200 /coupons pages by Google impressions (28 days to
// 2026-10-13), each spelling read from the store's own home page
// (og:site_name or <title>); where the page refused the fetch, only spellings
// the brand uses everywhere were added. All-caps styling is kept only for
// initialisms (PSD, ESET, KEH) and names never written otherwise (HTVRONT,
// KEEN). tests/unit/storeMetadata.test.ts pins every entry.
const BRAND_SPELLINGS: Readonly<Record<string, string>> = {
    airdoctorpro: 'AirDoctor Pro',
    amf: 'AMF',
    anovaculinary: 'Anova Culinary',
    ashleyfurniture: 'Ashley Furniture',
    'awd-it': 'AWD-IT',
    ballarddesigns: 'Ballard Designs',
    baxterofcalifornia: 'Baxter of California',
    bestbuy: 'Best Buy',
    bjs: "BJ's",
    bruntworkwear: 'Brunt Workwear',
    bulksupplements: 'BulkSupplements',
    chemistdirect: 'Chemist Direct',
    chicos: "Chico's",
    colibrirealestate: 'Colibri Real Estate',
    contactlensking: 'Contact Lens King',
    coursehero: 'Course Hero',
    cultbeauty: 'Cult Beauty',
    customizedgirl: 'CustomizedGirl',
    dare2b: 'Dare 2b',
    dennys: "Denny's",
    dhccare: 'DHC Care',
    dhgate: 'DHgate',
    discountgolfstore: 'Discount Golf Store',
    discountmugs: 'DiscountMugs',
    dominos: "Domino's",
    ebay: 'eBay',
    eharmony: 'eHarmony',
    eileenfisher: 'Eileen Fisher',
    elietahari: 'Elie Tahari',
    eset: 'ESET',
    fivebelow: 'Five Below',
    frenchtoast: 'French Toast',
    furniturevillage: 'Furniture Village',
    galacticsnowsports: 'Galactic Snow Sports',
    getthelabel: 'Get The Label',
    gifttree: 'GiftTree',
    glassesdirect: 'Glasses Direct',
    globalgolf: 'GlobalGolf',
    globalindustrial: 'Global Industrial',
    gotprint: 'GotPrint',
    grahamandgreen: 'Graham and Green',
    greatbigcanvas: 'Great Big Canvas',
    hawaiianairlines: 'Hawaiian Airlines',
    hawesandcurtis: 'Hawes & Curtis',
    healthexpress: 'Health Express',
    hempbombs: 'Hemp Bombs',
    hooverdirect: 'Hoover Direct',
    hotdiamonds: 'Hot Diamonds',
    hotelchocolat: 'Hotel Chocolat',
    htvront: 'HTVRONT',
    hudabeauty: 'Huda Beauty',
    humehealth: 'Hume Health',
    igloocoolers: 'Igloo Coolers',
    invictastores: 'Invicta Stores',
    irobot: 'iRobot',
    jerseymikes: "Jersey Mike's",
    kachava: "Ka'Chava",
    keenfootwear: 'KEEN Footwear',
    keh: 'KEH',
    kiehls: "Kiehl's",
    kindredbravely: 'Kindred Bravely',
    kindscience: 'Kind Science',
    kingsize: 'KingSize',
    kitchenaid: 'KitchenAid',
    kurtgeiger: 'Kurt Geiger',
    'laroche-posay': 'La Roche-Posay',
    livingproof: 'Living Proof',
    mackweldon: 'Mack Weldon',
    melissaanddoug: 'Melissa & Doug',
    michaelkors: 'Michael Kors',
    mountainwarehouse: 'Mountain Warehouse',
    musclenation: 'Muscle Nation',
    mypillow: 'MyPillow',
    oakfurnitureland: 'Oak Furnitureland',
    onetravel: 'OneTravel',
    panerabread: 'Panera Bread',
    parksleepfly: 'ParkSleepFly',
    petsmart: 'PetSmart',
    pgatoursuperstore: 'PGA Tour Superstore',
    photobookuk: 'Photobook UK',
    prettylittlething: 'PrettyLittleThing',
    psd: 'PSD',
    pyramydair: 'Pyramyd Air',
    raymourflanigan: 'Raymour & Flanigan',
    ryzesuperfoods: 'Ryze Superfoods',
    saksfifthavenue: 'Saks Fifth Avenue',
    sarahraven: 'Sarah Raven',
    scottsdalegolf: 'Scottsdale Golf',
    scrubsandbeyond: 'Scrubs & Beyond',
    simplybe: 'Simply Be',
    skinnydiplondon: 'Skinnydip London',
    swimsuitsforall: 'Swimsuits For All',
    taxslayer: 'TaxSlayer',
    teacollection: 'Tea Collection',
    thecbdistillery: 'The CBDistillery',
    upliftdesk: 'Uplift Desk',
    veronicabeard: 'Veronica Beard',
    vistaprint: 'VistaPrint',
    vividseats: 'Vivid Seats',
    webce: 'WebCE',
    westmarine: 'West Marine',
    wolfandbadger: 'Wolf & Badger',
}

/** The name a shopper searches a store by: "Coursera" for coursera.org,
 *  "Philips Hue" for philips-hue.com. Falls back to the domain itself when it
 *  has no label in front of its public suffix. */
export function storeDisplayName(base: string): string {
    const label = parse(base).domainWithoutSuffix
    if (!label) return base
    const known = BRAND_SPELLINGS[label]
    if (known) return known
    return label
        .split('-')
        .filter(Boolean)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')
}

export type StoreMetadataInput = {
    /** Registrable store domain (resolveStoreDomain). */
    base: string
    /** Active (visible) codes: the count the page lists. */
    total: number
    facts: StoreCouponFacts
    /** UK store: "discount code" / "voucher" vocabulary. */
    uk: boolean
    /** Render time. A parameter so tests can pin it. */
    now: Date
}

function fitting(candidates: string[], max: number): string {
    return (
        candidates.find(candidate => candidate.length <= max) ??
        candidates[candidates.length - 1]
    )
}

function updatedRecently(lastUpdated: Date | null, now: Date): boolean {
    if (!lastUpdated) return false
    const age = now.getTime() - lastUpdated.getTime()
    return age >= 0 && age <= ACTIVE_CLAIM_MAX_AGE_MS
}

function sameUtcMonth(a: Date, b: Date): boolean {
    return (
        a.getUTCFullYear() === b.getUTCFullYear() &&
        a.getUTCMonth() === b.getUTCMonth()
    )
}

/** "October 2026" and "Oct 2026" for a list updated this month, else null. */
function updatedThisMonth(
    lastUpdated: Date | null,
    now: Date,
): { long: string; short: string } | null {
    if (!lastUpdated || !sameUtcMonth(lastUpdated, now)) return null
    const format = (month: 'long' | 'short') =>
        lastUpdated.toLocaleDateString('en-US', {
            month,
            year: 'numeric',
            timeZone: 'UTC',
        })
    return { long: format('long'), short: format('short') }
}

export function buildStoreTitle(input: StoreMetadataInput): string {
    const { base, total, facts, uk, now } = input
    const name = storeDisplayName(base)
    if (total <= 0) {
        // Noindexed empty state: no count, no date.
        const empty = uk
            ? `${name} Discount Codes & Voucher Codes`
            : `${name} Coupons & Promo Codes`
        return fitting([`${empty}${SITE_SUFFIX}`, empty], TITLE_MAX)
    }
    // T-7856 pilot (storeIntentPilot.ts): four stores lead with the term order
    // their query uses. Every other store takes the default head.
    const head =
        storeIntentPilotFor(base)?.titleHead ??
        (uk
            ? `${name} Discount Codes & Vouchers`
            : `${name} Promo Codes & Coupons`)
    const count = total.toLocaleString('en-US')
    const codes = total === 1 ? 'Code' : 'Codes'
    const month = updatedThisMonth(facts.lastUpdated, now)
    const dated = month
        ? [
              `${head}: ${count} ${codes}, ${month.long}${SITE_SUFFIX}`,
              `${head}: ${count} ${codes}, ${month.short}${SITE_SUFFIX}`,
              `${head}: ${count} ${codes}, ${month.long}`,
              `${head}: ${count} ${codes}, ${month.short}`,
          ]
        : []
    return fitting(
        [
            ...dated,
            ...(updatedRecently(facts.lastUpdated, now)
                ? [`${head}: ${count} Active ${codes}${SITE_SUFFIX}`]
                : []),
            `${head}: ${count} ${codes}${SITE_SUFFIX}`,
            `${head}: ${count} ${codes}`,
            `${head}${SITE_SUFFIX}`,
            head,
        ],
        TITLE_MAX,
    )
}

export function buildStoreDescription(input: StoreMetadataInput): string {
    const { base, total, facts, uk } = input
    const name = storeDisplayName(base)
    if (total <= 0) {
        return uk
            ? `Find ${name} discount codes, voucher codes and promo codes for ${base}, refreshed as new codes are found.`
            : `Find ${name} coupon codes, promo codes and discounts for ${base}, refreshed as new codes are found.`
    }
    const count = total.toLocaleString('en-US')
    const one = total === 1
    // The biggest percent-off amount among the listed codes: the same number
    // the FAQ states ("up to N% off").
    const upTo =
        facts.bestPercentOff !== null
            ? `, up to ${Number(facts.bestPercentOff.toFixed(1))}% off`
            : ''
    const full = uk
        ? one
            ? 'discount code'
            : 'discount codes, voucher codes & promo codes'
        : one
          ? 'promo code'
          : 'promo codes, coupons & discount codes'
    const short = uk
        ? one
            ? 'discount code'
            : 'discount codes & vouchers'
        : one
          ? 'promo code'
          : 'promo codes & coupons'
    const action = one
        ? "Copy it, or let Caramel's free extension try it at checkout."
        : "Copy a code, or let Caramel's free extension try them at checkout."
    // T-7856 pilot: say what the store is first, so "coursehero promo code"
    // readers see Coursera is the online-course platform. Tried before the
    // default candidates; they remain the fallback when it does not fit.
    const descriptor = storeIntentPilotFor(base)?.descriptor
    const described = descriptor
        ? [
              `${name}, ${descriptor}: ${count} ${full}${upTo}. ${action}`,
              `${name}, ${descriptor}: ${count} ${short}${upTo}. ${action}`,
              `${name}, ${descriptor}: ${count} ${short}${upTo}.`,
          ]
        : []
    return fitting(
        [
            ...described,
            `${count} ${name} ${full} for ${base}${upTo}. ${action}`,
            `${count} ${name} ${full}${upTo}. ${action}`,
            `${count} ${name} ${short}${upTo}. ${action}`,
            `${count} ${name} ${short}${upTo}.`,
        ],
        DESCRIPTION_MAX,
    )
}
