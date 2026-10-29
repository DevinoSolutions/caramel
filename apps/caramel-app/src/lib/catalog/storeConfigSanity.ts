// T-10492 / T-10493: store configs whose coupon input is some OTHER field.
//
// The coupons pipeline writes store_configs from what its crawler saw, and on
// 2026-10-29, 24 of the 3021 served rows pointed couponInput at a field that is
// not a promo box: a store-locator search (gorjana.com, dickeys.com), a ZIP or
// postal-code box (dtlr.com, whirlpool.com, cartersoshkosh.ca), an email field
// (shopmicas.com), a site search (houseofbruar.com), a gift-card-only input
// (mauijim.com, shopbala.com).
//
// Such a config does harm in two ways, both measured live:
//   - The extension only offers its prompt on a configured store when that
//     input (or its reveal toggle) is visible. A store-locator box is never on
//     the checkout, so gorjana.com shoppers never saw Caramel at all.
//   - Where the field IS on the page, a non-Shopify apply types each code into
//     it: a coupon code in the ZIP or email box.
// Not serving the row makes the store config-less, and the extension already
// has the right path for that: the platform-cart probe and the promo-box finder
// (store-detect.js isCheckout).
//
// The rule is deliberately narrow: a selector that names a non-coupon field AND
// carries no coupon word. A combined "Discount code or gift card" box names a
// coupon word and stays served. Field names that themselves contain "code"
// (zip code, postal code, gift card code) are taken out before the coupon-word
// test, so "Search by zip code" is not read as a coupon box.
//
// TODO(T-10492): the pipeline should stop producing these rows at the source
// (coupons pipeline lane, told 2026-10-29); this guard stays as the backstop.

const COUPON_WORD =
    /coupon|promo|discount|voucher|reduction|redeem|rabatt|gutschein|cupon|cupom|remise|sconto|korting|offer.?code|cpn|dcode|disc[-_]|source.?code|reward/i

const OTHER_FIELD_WORD =
    /zip|postal|post.?code|e-?mail|search|first.?name|last.?name|full.?name|phone|password|newsletter|subscribe|street|address|city|gift.?card|giftcard|gift.?cert|card.?number|cvv|quantity|qty/i

// Field names that contain the word "code" but are not a coupon code.
const CODE_NAMED_OTHER_FIELD =
    /zip.?code|post.?code|postal.?code|gift.?card.?(code|number|pin)/gi

/**
 * True when a store config's coupon-input selector names a field that is not a
 * promo box (ZIP, postal code, email, search, name, phone, gift card only...)
 * and carries no coupon word. Such a config is not served to the extension.
 */
export function couponInputNamesOtherField(
    couponInput: string | null | undefined,
): boolean {
    if (!couponInput) return false
    if (!OTHER_FIELD_WORD.test(couponInput)) return false
    return !COUPON_WORD.test(couponInput.replace(CODE_NAMED_OTHER_FIELD, ''))
}
