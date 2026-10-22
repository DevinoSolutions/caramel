// A pinned copy of the extension's outline word list and of the filter that
// applies it (apps/caramel-extension/coupon-box-outline.js ALLOWED_WORDS and
// caramelAllowedWords). The extension drops every other word before an
// outline leaves the browser, so a name in an eval fixture, or a word a
// server rule keys on, is only real when this list keeps it. The app does not
// import the extension's code; tests/unit/coupon-box-outline-words.test.ts
// fails when the copy and the extension drift apart.
//
// The list is the one of 2026-10-17, which adds point(s), member(s),
// military, student(s), teacher(s), verify and verification.
export const OUTLINE_WORDS: ReadonlySet<string> = new Set(
    `
    a about accent accept accessibility accessories account achat act
    actiecode active add address affiliate affiliates affirm agree air
    aktionscode all allow also always american an and anwenden apartment
    aplicar app applica applied appliquer apply are arrivals art as at
    available avez back bag bags balance bar basket bath bathroom be become
    bed bedding bedroom beds bedside benefits best bestsellers billing blog
    body bon book bookcases books boots box brand brands bundles buono
    business buy by cadeau cadeaubon can cancel candles canjear canvas card
    cards care careers cart categories center certificate certificates chair
    chairs chance change chat check checkbox checkout chest choices choose
    christmas chrome city classic clean cleaning clear clearance click close
    clothing club code codes codice coffee collection collections com
    commercial company compare conditions confirm consent console consumer
    contact content continue control cookie cookies corporate cost country
    coupon coupons create credit cupom cupones cupón curated current
    cushions custom customer código data day deal deals decor decrease
    delete delivery desconto descuento design desk desks details dialog
    digital diners dining discount discounts discover do double drawers du
    easy edge edit eingeben einlösen elo email empty enjoy enter essential
    essentials etc event every exchanges exclusive expand explore express
    fabric face facebook fall faq faqs favorites featured feedback filter
    finalize financing find finder first fit floor footer footwear for
    frames free frequently fresh friend from full functional furniture
    gavekort get gift giftcard giftcards gifts gloves go golf got guarantee
    guide gutschein gutscheincode hand hast have health help here hide high
    history holiday home homepage how i ideal if ihr image in increase info
    information inserisci instagram invoeren is it item items jackets jcb
    join kampanjkod keep kids kitchen klarna know kod korting kortingscode
    label language last later learn leather left legal less light lighting
    like links list live living log login logo low loyalty made main manage
    map mattresses me media member members membership men menu message
    method military mini mirrors mobile modal modern more move my name
    navigate navigation necessary need new news next night no not notice
    notifications now number nursery of off offer offers office ok on one
    onetrust online only open opens optional options or order orders
    original our out outdoor outlet over pack page pants password pay
    payment paypal performance personal phone photo pillows pinterest place
    play plus point points policies policy postal power powered pre
    preference preferences presentkort press previous price privacy pro
    problem proceed product products program promo promos promotion
    promotional promotions protection province purchase qty qualify quantity
    questions quick rabatkode rabatowy rabatt rabattcode rabattkod receive
    redeem redemption refer refresh refund refunds region register remember
    remise remove report required resgatar resources retail return returns
    review reviews reward rewards right rights room rugs réduction safety
    saisir sale sales save sconto scroll search season seater secure
    security see select sell sellers service services set sets settings
    share ship shipping shoes shop shopping shorts show side sideboards sign
    site sitemap size skip sleep slide small social sofas space special
    start state statement status stools storage store stores story street
    strictly student students style submenu submit subscribe subtotal suite
    summary summarytotal supplies support sustainability tab table tables
    targeting tax teacher teachers team terms text that the there this
    tienes tiktok time tips to toepassen toggle tools top tops total track
    tracking trade traditional training travel trending tu twitter type un
    una under une unionpay up update updates use used value verification
    verify view votre voucher vouchers vous wall warranty was water we
    website what window wishlist with women world wrap you your youtube zip
    zniżka
`
        .split(/\s+/)
        .filter(Boolean),
)

// TODO(2026-10-17): the 2026-10-17 words reach the extension's own list with
// the extension change that ships them. Until then its file lacks exactly
// these; drop this set, and the drift test's allowance for it, once
// apps/caramel-extension/coupon-box-outline.js carries them.
export const EXTENSION_WORDS_PENDING: ReadonlySet<string> = new Set([
    'member',
    'members',
    'military',
    'point',
    'points',
    'student',
    'students',
    'teacher',
    'teachers',
    'verification',
    'verify',
])

// Built with the constructor: this project's compile target rejects the
// literal `u` flag.
const NOT_A_LETTER = new RegExp('[^\\p{L}]+', 'gu')

/** `name` with only the listed words, as caramelAllowedWords keeps them: a
 * whitespace-separated token is kept when every run of letters in it is a
 * listed word (lowercased), or when it has no letters at all. */
export function outlineWordsOnly(name: string): string {
    return name
        .split(/\s+/)
        .filter(token => {
            const letters = token
                .toLowerCase()
                .replace(NOT_A_LETTER, ' ')
                .trim()
            return (
                !letters || letters.split(' ').every(w => OUTLINE_WORDS.has(w))
            )
        })
        .join(' ')
        .trim()
}
