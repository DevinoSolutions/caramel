// src/lib/couponBoxPick.ts
//
// Coupon-box pick: when the extension's rules cannot find a store's coupon
// code box, it sends a privacy-trimmed outline of the cart page and a model
// picks which element is the coupon input, its apply button, or the toggle
// that reveals a hidden box.
//
// The outline is accessibility-tree style, one node per line:
//
//   - form:
//     - [7] textbox "Discount Code (Optional)"
//     - [8] button "Apply"
//
// Interactive nodes carry an `[n]` index the extension maps back to the real
// element; the extension has already replaced every digit in the labels with
// `#` and carries no free page text. This module re-scrubs anyway (defence in
// depth) and only ever returns indexes that exist in the outline it was given.
//
// Eval-gated: evals/couponBoxPick.eval.ts runs THIS module (prompt, parsing,
// index validation — imported, never copied) against labelled real cart pages.
// Change the prompt or the model only through that suite (evals/README.md).
import { createCouponBoxAnswerCache } from '@/lib/couponBoxPickAnswerCache'
import { env } from '@/lib/env'
import { firstJsonObject } from '@/lib/llmJson'
import { chat } from '@/lib/openrouter'
import { proxyFallbackHeaders } from '@/lib/proxy-fallback-env'
import * as Sentry from '@sentry/nextjs'
import { z } from 'zod'

/** Largest outline the pick accepts, in UTF-8 bytes. The route caps the whole
 * request body a little above this. */
export const MAX_OUTLINE_BYTES = 40 * 1024

// The system prompt, verbatim as it was measured (see the eval scoreboard).
const SYSTEM_PROMPT = [
    'You find the coupon / promo / discount code box on a shopping cart or checkout page.',
    'You get the page\'s accessibility tree (role "name": text), in reading order. Every input and clickable element is prefixed [n]. Answer with those n numbers.',
    'Answer JSON only, no prose: {"input": <n or null>, "button": <n or null>, "toggle": <n or null>, "confidence": 0-100, "why": "<10 words>"}',
    '- "input": the field where a shopper types a coupon, promo, discount, voucher or gift-card-or-discount code. Never a search box, postcode, quantity, newsletter/email, gift message or loyalty-number field, and never a field that takes ONLY a gift card.',
    '- A hidden or disabled input can still be THE box (behind a "Have a promo code?" link, or disabled on an empty cart).',
    '- "button": the control that applies that code (Apply, Redeem, OK, Submit beside the box), or null when the box has none and applies on Enter. Redeem only beside a field that names a code. Never checkout, pay, place-order, remove, sign-in or a rewards control.',
    '- "toggle": the control that reveals a hidden field to TYPE a code into ("Have a promo code?", "Promo code +", "Add discount code", "Have a discount?"); else null. Its own text must say code, coupon or discount: "Promo Code", "Apply Promo Code", "Add coupon" or "Add discount" IS the toggle when no code field is visible. A control that offers deals but names no code ("View offers", "Available offers", "Promotions") is never the toggle.',
    '- Never the toggle: details about a promotion ("Promo details"); a rewards, points, loyalty or membership control, or one that redeems them for a code; a member, student, military or teacher discount, or a link to verify one; a discount control beside a points or credit balance.',
    '- A control only for a gift card, gift code, gift certificate or gift voucher ("Have a gift code?", "Apply gift card") is not a coupon control: never answer it as input, button or toggle.',
    '- No coupon box and no toggle on the page: input null and toggle null. A wrong field is worse than none. But a visible control whose own text says code, coupon or discount (never a gift code, never a rewards redemption) means the box is behind it: answer that control as the toggle, not no box.',
].join('\n')

// A reasoning model's hidden reasoning counts against max_tokens (the F-017
// lesson in evals/SCOREBOARD.md), so this is sized for the reasoning plus a
// one-line JSON answer, not for the answer alone.
const MAX_TOKENS = 1000
// Measured on the eval set (sequential): p50 ~4s, slowest answer 13.6s.
const TIMEOUT_MS = 20_000
const WHY_MAX_CHARS = 200
const RAW_REPLY_LOG_MAX = 300

/** The store's host as the extension sends it. ONE definition, shared with
 * the coupon-box save (couponBoxSave.ts), so both read a host the same way. */
export const couponBoxDomainSchema = z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9.-]{3,120}$/)

export const couponBoxPickRequestSchema = z.object({
    domain: couponBoxDomainSchema,
    outline: z.string().min(1),
})

export type CouponBoxPickRequest = z.infer<typeof couponBoxPickRequestSchema>

/** The model found the box (`input`) or a control that reveals it (`toggle`);
 * at least one of the two is set. Every index exists in the outline. */
interface CouponBoxFound {
    outcome: 'box'
    input: number | null
    button: number | null
    toggle: number | null
    confidence: number
    why: string
    cached: boolean
}

/** The model answered, and its answer is that the page has no coupon box. */
interface CouponBoxAbsent {
    outcome: 'no_box'
    confidence: number
    why: string
    cached: boolean
}

/** No answer: the feature is off, or the model call failed or returned
 * something unusable. The extension treats it exactly like "rules found
 * nothing". */
interface CouponBoxNoPick {
    outcome: 'no_pick'
    reason: 'disabled' | 'model_error' | 'unparsable'
}

/** The model answered, but named an apply button the server refuses: an
 * order, pay, sign-in or rewards control, or an index of no clickable line.
 * Not the same as naming no button, which the extension reads as "this box
 * applies on Enter": Enter in a field beside that control can submit it. The
 * extension uses nothing from this answer, like `no_pick`. */
interface CouponBoxRefusedButton {
    outcome: 'no_pick'
    reason: 'refused_button'
    cached: boolean
}

export type CouponBoxPickResult =
    CouponBoxFound | CouponBoxAbsent | CouponBoxNoPick | CouponBoxRefusedButton

type CachedAnswer =
    | Omit<CouponBoxFound, 'cached'>
    | Omit<CouponBoxAbsent, 'cached'>
    | Omit<CouponBoxRefusedButton, 'cached'>

export class CouponBoxOutlineTooLargeError extends Error {
    constructor(readonly bytes: number) {
        super(
            `coupon-box outline is ${bytes} bytes; the limit is ${MAX_OUTLINE_BYTES}`,
        )
        this.name = 'CouponBoxOutlineTooLargeError'
    }
}

/** The feature switch the route and the extension's feature read share: on
 * only when explicitly enabled AND a model is configured. */
export function couponBoxLlmEnabled(): boolean {
    return env.COUPON_BOX_LLM_ENABLED && Boolean(env.COUPON_BOX_PICK_MODEL)
}

// Bounded runs: with open-ended ones, a long word with no "@" (an outline is
// guest-written) makes every start scan to the end of the line, and a 40 KiB
// line took seconds. An address's local part is at most 64 characters, a
// domain at most 253.
const EMAIL_SHAPED = /[\w.+-]{1,64}@[\w-]{1,253}\.[\w.]{1,253}/g
// A node line's leading `- [n] role` head. Its index is the only number the
// outline may keep, and only when a role word follows it: a line of page text
// that happens to start like an index is scrubbed like any other text.
const NODE_HEAD = /^\s*- \[(\d{1,6})\] (?=[a-z]+\b)/
// Every line break a browser can put in an accessible name, not only \n.
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/

// Any Unicode number (\p{N}), not just 0-9: a phone number in Arabic-Indic,
// Persian or fullwidth digits is still a phone number. Built with the
// constructor because this project's compile target rejects the literal `u`
// flag; every runtime we run on supports it.
const ANY_DIGIT = new RegExp('\\p{N}', 'gu')
function scrubText(text: string): string {
    return text.replace(EMAIL_SHAPED, '[email]').replace(ANY_DIGIT, '#')
}

/** Every digit becomes `#` and anything email-shaped becomes `[email]`,
 * except the `[n]` index at the start of a node line (the extension maps the
 * pick back through it). */
export function scrubOutline(outline: string): string {
    return outline
        .split(LINE_BREAK)
        .map(line => {
            const head = NODE_HEAD.exec(line)?.[0] ?? ''
            return head + scrubText(line.slice(head.length))
        })
        .join('\n')
}

interface OutlineLine {
    role: string
    /** The accessible name between the quotes, '' when the line has none. */
    name: string
    /** The `[n]` index, on interactive lines only. */
    index: number | null
    /** The enclosing line's position in the list, -1 at the top level. */
    parent: number
    children: number[]
}

// Any outline line, node or container: its indent, its [n] index (nodes
// only), its role and the rest of the line.
const OUTLINE_LINE = /^(\s*)- (?:\[(\d{1,6})\] )?([a-z]+)\b(.*)$/
// The rest of a line: ` "name"`, then a state (` [collapsed]`), then the
// container colon. A name can itself hold a quote, so it runs to the last one.
const LINE_NAME = /^ "(.*)"(?: \[[a-z, ]+\])?:?$/
const DIALOG_ROLES = new Set(['dialog', 'alertdialog'])
// A field a shopper types into: a box beside a control says what it is for.
const FIELD_ROLES = new Set(['textbox', 'searchbox', 'spinbutton'])
// What a section holds besides a heading that marks it as a block of the cart
// (a line item), not the section's own title.
const LINE_ITEM_ROLES = new Set([
    'textbox',
    'searchbox',
    'spinbutton',
    'combobox',
])
// The containers that name a section of the page ("Rewards", "Order
// summary"): the outline prints a <section> only when it is named, and a
// <form> counts only when named, as a cart form wrapping the line items is no
// section of its own.
const SECTION_ROLES = new Set([
    'region',
    'group',
    'complementary',
    'dialog',
    'alertdialog',
])
// A price, as the outline prints one (every digit is "#").
const MONEY = /[$€£¥₹]\s?#|#\s?[$€£]|#[.,]##\b/
// A footer is the cart's own summary, not the page footer, when one of its
// buttons checks out or places the order, or it names a subtotal or an order
// summary. A link or a bare "total" is not enough: a site footer has "Check
// out our blog" and "Total satisfaction".
const CART_BUTTON = /check ?out|place (?:my |your )?order/i
const CART_SUMMARY = /subtotal|order summary/i
// The extension cuts a control's name at 80 characters, a heading's at 100
// and a container's at 60 (coupon-box-outline.js). The rules read no more than
// this of a name: the outline is guest-written, and every rule below then runs
// on a bounded string, whatever a caller sends.
const NAME_MAX_CHARS = 120
// The words beside a control and its section's name, at most this long, as
// coupon-box-discovery.js reads them (RULE_WORDS_MAX): no block a shopper
// reads beside a control is longer.
const RULE_WORDS_MAX = 1000
const ruleWords = (t: string) => t.slice(0, RULE_WORDS_MAX)
// The extension drops whole lines past its cap (coupon-box-outline.js), so an
// outline this close to MAX_OUTLINE_BYTES may have lost its real page footer.
const NEAR_CAP_BYTES = 1024

/** The outline as a tree, read from the SCRUBBED outline (the one the model
 * saw). Nesting is read from the indent. */
class Outline {
    readonly lines: OutlineLine[] = []
    /** Index -> its line's position. */
    readonly byIndex = new Map<number, number>()

    constructor(outline: string) {
        // The lines that enclose the current one, innermost last.
        const open: { indent: number; at: number }[] = []
        for (const raw of outline.split('\n')) {
            const m = OUTLINE_LINE.exec(raw)
            if (!m) continue
            const indent = (m[1] ?? '').length
            while (open.length && open[open.length - 1]!.indent >= indent)
                open.pop()
            const parent = open.length ? open[open.length - 1]!.at : -1
            const at = this.lines.length
            const index = m[2] === undefined ? null : Number(m[2])
            this.lines.push({
                role: m[3] ?? '',
                name: (LINE_NAME.exec(m[4] ?? '')?.[1] ?? '').slice(
                    0,
                    NAME_MAX_CHARS,
                ),
                index,
                parent,
                children: [],
            })
            if (parent >= 0) this.lines[parent]!.children.push(at)
            if (index !== null) this.byIndex.set(index, at)
            open.push({ indent, at })
        }
    }

    line(index: number | null): OutlineLine | undefined {
        if (index === null) return undefined
        const at = this.byIndex.get(index)
        return at === undefined ? undefined : this.lines[at]
    }

    /** Every line under `at`, in reading order. */
    below(at: number): number[] {
        return this.lines[at]!.children.flatMap(c => [c, ...this.below(c)])
    }

    /** The words of a line and everything under it. */
    words(at: number): string {
        return [at, ...this.below(at)]
            .map(i => this.lines[i]!.name)
            .filter(Boolean)
            .join(' ')
    }

    holds(at: number, roles: Set<string>): boolean {
        return this.below(at).some(i => roles.has(this.lines[i]!.role))
    }

    siblings(at: number): number[] {
        const parent = this.lines[at]!.parent
        return parent < 0
            ? this.lines.flatMap((l, i) => (l.parent < 0 ? [i] : []))
            : this.lines[parent]!.children
    }

    /** The words a shopper reads beside a line: the small block around it,
     * or, once a block also holds a field, only its own neighbours (a field
     * by its name, any other neighbour by its words unless it holds a field
     * of its own). coupon-box-discovery.js wordsBeside, on the outline. */
    beside(at: number): string {
        let words = ''
        for (let n = at, k = 0; k < 3; k++) {
            const p = this.lines[n]!.parent
            if (p < 0) break
            if (this.holds(p, FIELD_ROLES)) {
                const sibs = this.siblings(n)
                const i = sibs.indexOf(n)
                for (const s of [sibs[i - 1], sibs[i + 1]]) {
                    if (s === undefined) continue
                    if (FIELD_ROLES.has(this.lines[s]!.role))
                        words += ' ' + this.lines[s]!.name
                    else if (!this.holds(s, FIELD_ROLES))
                        words += ' ' + this.words(s)
                }
                break
            }
            if (this.words(p).length > 160) break
            words = this.words(p)
            n = p
        }
        return ruleWords(words)
    }

    /** The section a line sits in, by its own name: the section's name, and
     * the nearest heading before the line that heads the section rather than
     * a line item in it (a block holding a field or a price).
     * coupon-box-discovery.js sectionWords, on the outline. */
    section(at: number): string {
        let box = this.lines[at]!.parent
        while (box >= 0) {
            const l = this.lines[box]!
            if (SECTION_ROLES.has(l.role) || (l.role === 'form' && l.name))
                break
            box = l.parent
        }
        if (box < 0) return ''
        let head = ''
        for (let n = at; !head && n !== box; n = this.lines[n]!.parent) {
            const sibs = this.siblings(n)
            for (let i = sibs.indexOf(n) - 1; !head && i >= 0; i--) {
                const s = sibs[i]!
                const h =
                    this.lines[s]!.role === 'heading'
                        ? s
                        : this.below(s).find(
                              j => this.lines[j]!.role === 'heading',
                          )
                if (
                    h !== undefined &&
                    (h === s ||
                        !(
                            this.holds(s, LINE_ITEM_ROLES) ||
                            MONEY.test(this.words(s))
                        ))
                )
                    head = this.lines[h]!.name
            }
        }
        return ruleWords(`${this.lines[box]!.name} ${head}`)
    }

    /** A cart's own summary, by its buttons and its words. */
    cartSummary(at: number): boolean {
        return (
            CART_SUMMARY.test(this.words(at)) ||
            this.below(at).some(
                i =>
                    this.lines[i]!.role === 'button' &&
                    CART_BUTTON.test(this.lines[i]!.name),
            )
        )
    }

    /** Inside the page's own footer: the LAST contentinfo nested in no other
     * line that is no cart summary (a cart summary can be drawn as a
     * <footer>, before or after the site footer), and not inside a dialog
     * opened from it. None in an outline that may have been cut at the cap:
     * its last footer may be a cart's. */
    inPageFooter(at: number, mayBeCut: boolean): boolean {
        if (mayBeCut) return false
        let footer = -1
        for (let i = this.lines.length - 1; footer < 0 && i >= 0; i--) {
            const l = this.lines[i]!
            if (
                l.parent < 0 &&
                l.role === 'contentinfo' &&
                !this.cartSummary(i)
            )
                footer = i
        }
        if (footer < 0) return false
        for (
            let p = this.lines[at]!.parent;
            p >= 0;
            p = this.lines[p]!.parent
        ) {
            if (DIALOG_ROLES.has(this.lines[p]!.role)) return false
            if (p === footer) return true
        }
        return false
    }
}

// The roles each pick may have. The extension types into the input and
// CLICKS the button and the toggle, so a pick of another kind of element is
// refused rather than trusted.
const INPUT_ROLES = new Set(['textbox', 'combobox', 'searchbox'])
const CLICK_ROLES = new Set(['button', 'link', 'tab', 'checkbox', 'switch'])
// A control the extension must never click on the model's word, whatever its
// role: it leaves the cart, moves the checkout on a step, spends money,
// removes items or signs in. coupon-box-discovery.js carries the same list for
// the clicks it makes. A name that is only "order" is a "Complete order"
// button: "complete" is not on the extension's word list, so the outline
// prints what is left.
const NEVER_CLICK =
    /check ?out|place (?:my |your )?order|\bpay\b|pay ?pal|pay now|buy now|purchase|\bremove\b|\bdelete\b|empty (?:cart|basket|bag)|sign ?in|sign ?up|log ?in|register|create (?:an )?account|subscribe|continue|\bproceed\b|\bnext\b|^\W*(?:(?:my|your|the)\s+)?orders?\W*$/i
// The extension's guard on every click it makes (dom-utils.js
// CARAMEL_FORBIDDEN_CONTROL_RE, byte-identical): placing, paying for or
// confirming an order, emptying the cart, signing out.
const FORBIDDEN_CONTROL =
    /\b(place\s+(your\s+)?order|pay\s+(now|today)|complete\s+(your\s+)?(order|purchase)|submit\s+order|confirm\s+(and\s+pay|order|purchase)|buy\s+now|proceed\s+to\s+(pay|checkout)|checkout\s+now|delete\s+account)\b|\b(remove|delete)\s+(this\s+)?(item|product|line|all|address|card|everything|from\s+(bag|cart|basket|order))\b|\b(empty|clear)\s+(your\s+)?(cart|bag|basket|trolley)\b|\b(log|sign)\s*out\b|\b(jetzt\s+kaufen|kauf(en)?\s+abschlie(ss|ß)en|zahlungspflichtig\s+bestellen|bestellung\s+abschicken|commander(\s+et\s+payer)?|payer\s+maintenant|valider\s+(la\s+)?commande|realizar\s+(el\s+)?pedido|comprar\s+ahora|pagar\s+ahora|finalizar\s+(la\s+)?compra|acquista\s+ora|procedi\s+al\s+pagamento)\b/i
// coupon-box-discovery.js noCodeClick, byte-identical: a control that adds to
// the cart or buys, adds a gift extra, protection, a warranty, insurance or a
// donation, saves or updates the cart, subscribes, or signs in or up. "Gift
// card or discount code" names a code and is still a coupon control.
const NO_CODE_CLICK_RE =
    /\badd(?:ing)? (?:it )?to (?:my |your |the )?(?:cart|bag|basket|order)\b|\bbuy\b|\bprotection\b|\bwarrant(?:y|ies)\b|\binsurance\b|\bdonat(?:e|ion)s?\b|\bround(?:ing)? ?up\b|\b(?:save|update) (?:my |your |the )?(?:cart|bag|basket|qty|quantit(?:y|ies))\b|\bsave for later\b|\bsubscri(?:be|ption)s?\b|\bnewsletters?\b|\bsign(?:ing)? ?(?:in|up)\b|\blog ?in\b/i
const GIFT_EXTRA_RE =
    /\bgift ?(?:card|wrap\w*|message|note|receipt|box|bag)s?\b/i
const PROMO_WORD_RE = /\b(?:promo\w*|coupons?|discounts?|vouchers?)\b/i
const giftOnly = (t: string) => GIFT_EXTRA_RE.test(t) && !PROMO_WORD_RE.test(t)
const noCodeClick = (t: string) => NO_CODE_CLICK_RE.test(t) || giftOnly(t)
// coupon-box-discovery.js settingControl, byte-identical patterns: a switch or
// a radio is a setting, never a fold, and so is a checkbox that does not speak
// of entering a code or that asks for consent.
const CODE_ENTRY_RE =
    /\b(?:promo(?:tional)?|coupon|discount|voucher|offer|gift)\s+codes?\b|\b(?:have|got|enter|add|apply|use)\s{1,8}(?:a|an|your)?\s{0,8}(?:promo(?:tional)?|coupon|discount|voucher)\b(?!\s+(?:card|balance|points))/i
const CONSENT_RE =
    /\b(?:e-?mail|sms|text me|newsletter|subscri\w*|sign me up|send me|notif\w*|marketing)\b/i
function settingControl(line: OutlineLine): boolean {
    if (/^(?:switch|radio|menuitemradio|menuitemcheckbox)$/.test(line.role))
        return true
    if (line.role !== 'checkbox') return false
    return !CODE_ENTRY_RE.test(line.name) || CONSENT_RE.test(line.name)
}

// Rewards are the shopper's own money: a control that redeems points or
// rewards, or picks a member, student, military or teacher discount, is never
// clicked on the model's word, as the toggle or as the apply button. Judged by
// the control's own name and by the words around it, with the phrases that
// name a code taken out first ("Promo or rewards code"), so a code box's own
// label never refuses its button. The same rule as coupon-box-discovery.js
// (LOYALTY_RE, withoutCodePhrases, spendsPoints), which sees the page; the
// server sees only the outline's words. An extension older than the
// 2026-10-17 word list drops "points", "member", "student", "military",
// "teacher" and "verify" from the outline, and the extension's own check is
// then the one that sees them.
const LOYALTY =
    /\b(?:redeem(?:s|ed|ing)?|points?|rewards?|loyalty|memberships?|member pric(?:e|es|ing)|students?|military|teachers?|verif(?:y|ied|ication))\b/i
// Store credit and a balance are the shopper's money too: applying them drops
// the total and reads as a saving that is not one. "Credit card" is a payment
// method. A gift card is judged by noCodeClick on the control's own name, as
// "Promo code or gift card" still reveals the coupon box.
const STORE_CREDIT =
    /\bstore credits?\b|\bcredits?\b(?! ?cards?)|\bbalances?\b/i
const REDEEM = /\bredeem/i
const REDEEM_WORDS = /\bredeem\w*/gi
// Every run is bounded: an open-ended one backtracks over a long word on
// every start, and a 40 KiB word took over a second.
const withoutCodePhrases = (t: string) =>
    t.replace(
        /(?:[\w-]{1,40}\s{1,8}(?:or|and|&|\/)\s{1,8})?[\w-]{1,40}\s{1,8}codes?\b/gi,
        ' ',
    )
// "Redeem ### points for a $# discount code" spends points to get a code,
// whatever it names. A toggle opens a box to type a code into; this buys one.
// Bounded gaps: two open-ended ones made a long name cubic.
const REDEEM_FOR_A_CODE =
    /\bredeem\w{0,8}\b.{0,60}?\bfor\b.{0,40}?\b(?:codes?|coupons?|vouchers?)\b/i
// Words that name a code, in the store languages the outline keeps. "kod"
// also inside a word (Swedish "rabattkod", "kampanjkod"); "promo" only as a
// word, so "promotions" is an offer, not a code. "de" is not on the
// extension's word list, so "Bon de réduction" reaches the server as "Bon
// réduction"; the extension reads the page, where it is still there.
const NAMES_CODE =
    /code|codice|código|kod|coupon|cup[oó]n|cupom|voucher|gutschein|\bpromo\b|\bbons?\b(?:\s+de)?\s+r[ée]duction/i
// A code for a coupon, not one only for a gift card ("Gift card code").
const namesCouponCode = (t: string) => NAMES_CODE.test(t) && !giftOnly(t)
// A toggle opens a box to type a code into. One that offers deals without
// naming a code ("View offers", "Available offers") applies an offer or opens
// a list of them, and one about the small print ("Promo details") explains
// one. One that says only "discount" ("Have a discount?", "Add discount") is
// a code box's fold, unless it or the words around it speak of points,
// rewards, membership, a gift card or a group discount ("Apply discount"
// under a points balance). coupon-box-discovery.js offersOnly, on the outline.
const SAYS_OFFER = /offer|\bdeals?\b|saving|\bsave\b|promotions?\b/i
const SAYS_DISCOUNT =
    /discount|rabatt|descuento|desconto|sconto|remise|réduction|korting|zniżka/i
const MEMBER_OR_GIFT = /\bmembers?\b|\bgift[\s-]*cards?\b/i
const ABOUT_TERMS =
    /\b(?:details|terms|conditions|exclusions|restrictions|learn more)\b/i
// "Promo details" is the small print; "Coupon code details" opens a box.
const CODE_WORD = /\b(?:codes?|coupons?|vouchers?)\b/i

/** A control's own name as the rules read it: hyphens and underscores as
 * spaces, as coupon-box-discovery.js controlWords reads them. */
const controlWords = (line: OutlineLine) => line.name.replace(/[-_]+/g, ' ')

/** A clicked control that spends the shopper's rewards or store credit.
 * coupon-box-discovery.js spendsPoints, on the outline. One whose own name,
 * the phrases that name a code taken out, speaks of points, rewards, a
 * membership or store credit is refused, and so is one that redeems points for
 * a code. One that names a code ("Apply code") is then kept wherever it sits,
 * a Rewards section included. Any other is judged by the words beside it and
 * its section's name: "Redeem" is kept only when it or the field beside it
 * names a coupon code, and a plain "Apply" is refused under points, under
 * store credit, or beside a gift card's field, unless something beside it
 * names a coupon code. */
function spendsPoints(tree: Outline, at: number): boolean {
    const own = controlWords(tree.lines[at]!)
    const ownWords = withoutCodePhrases(own).replace(REDEEM_WORDS, '')
    if (LOYALTY.test(ownWords) || STORE_CREDIT.test(ownWords)) return true
    if (REDEEM_FOR_A_CODE.test(own)) return true
    if (CODE_WORD.test(own)) return false
    const beside = tree.beside(at)
    if (REDEEM.test(own) && !namesCouponCode(own) && !namesCouponCode(beside))
        return true
    const near = withoutCodePhrases(`${beside} ${tree.section(at)}`).replace(
        REDEEM_WORDS,
        '',
    )
    if (LOYALTY.test(near)) return true
    return (
        !namesCouponCode(beside) &&
        (STORE_CREDIT.test(near) || giftOnly(beside))
    )
}

/** A field that takes points or store credit rather than a code ("Points to
 * redeem"): typing a code there and pressing Enter spends them. The same rule
 * as coupon-box-discovery.js pointsField, on the field's outline name. */
const pointsField = (name: string) =>
    (LOYALTY.test(name) || STORE_CREDIT.test(name)) && !CODE_WORD.test(name)

/** A toggle that names no code: an offer, the small print, or a discount
 * beside points, rewards, a membership, a gift card or store credit. */
function offersOnly(tree: Outline, at: number): boolean {
    const own = controlWords(tree.lines[at]!)
    if (ABOUT_TERMS.test(own) && !CODE_WORD.test(own)) return true
    if (NAMES_CODE.test(own)) return false
    if (SAYS_OFFER.test(own)) return true
    if (!SAYS_DISCOUNT.test(own)) return false
    const near = withoutCodePhrases(
        `${own} ${tree.beside(at)} ${tree.section(at)}`,
    )
    return (
        LOYALTY.test(near) ||
        MEMBER_OR_GIFT.test(near) ||
        STORE_CREDIT.test(near)
    )
}

// A short apply verb, the whole of a control's name.
const APPLY_VERB =
    /^(?:apply|redeem|submit|ok|go|use|add|anwenden|einlösen|aplicar|appliquer|applica|toepassen|canjear|resgatar)$/i

/** The apply button for `input` when the model named a control ABOVE the
 * field that names the code ("Apply Promo Code" heading a box, which folds
 * it): the first control after the field in the same block, when it is a
 * short apply verb ("Apply"). onekingslane.com: a click on the heading after
 * typing folds the box instead of applying the code. Any other answer is
 * returned as it is. */
function applyAfterField(
    tree: Outline,
    button: number | null,
    input: number | null,
): number | null {
    const b = button === null ? undefined : tree.byIndex.get(button)
    const f = input === null ? undefined : tree.byIndex.get(input)
    if (b === undefined || f === undefined) return button
    if (
        !CLICK_ROLES.has(tree.lines[b]!.role) ||
        !NAMES_CODE.test(tree.lines[b]!.name) ||
        tree.lines[b]!.parent !== tree.lines[f]!.parent
    )
        return button
    const sibs = tree.siblings(f)
    const fi = sibs.indexOf(f)
    if (sibs.indexOf(b) >= fi) return button
    const next = sibs
        .slice(fi + 1)
        .find(s => CLICK_ROLES.has(tree.lines[s]!.role))
    if (next === undefined) return button
    return APPLY_VERB.test(tree.lines[next]!.name.trim())
        ? tree.lines[next]!.index
        : button
}

interface Answer {
    input: number | null
    button: number | null
    toggle: number | null
    confidence: number
    why: string
}

// A malformed index is a non-answer for THAT field, never a reason to throw
// away the whole pick; the confidence and the reason are cosmetic.
const asIndex = (v: unknown) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null

function toAnswer(o: Record<string, unknown>): Answer {
    const c =
        typeof o.confidence === 'string' ? Number(o.confidence) : o.confidence
    return {
        input: asIndex(o.input),
        button: asIndex(o.button),
        toggle: asIndex(o.toggle),
        confidence:
            typeof c === 'number' && Number.isFinite(c)
                ? Math.min(100, Math.max(0, c))
                : 0,
        why: typeof o.why === 'string' ? o.why.slice(0, WHY_MAX_CHARS) : '',
    }
}

function parseAnswer(raw: string): Answer | null {
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        try {
            parsed = firstJsonObject(raw)
        } catch {
            return null
        }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return null
    return toAnswer(parsed as Record<string, unknown>)
}

/**
 * The model's answer, checked against the outline it was given.
 *
 * - An index the outline does not contain is a hallucination, and an index
 *   of the wrong kind of element is refused.
 * - A refused input or toggle becomes null. An input is refused when its name
 *   is for points or store credit, not a code (pointsField). A toggle is
 *   refused when it is in
 *   the page footer, names no code (offersOnly), is a setting
 *   (settingControl), or fails the checks every clicked pick passes: it is
 *   no NEVER_CLICK, FORBIDDEN_CONTROL or noCodeClick control and spends no
 *   rewards or store credit (spendsPoints).
 * - With neither an input nor a toggle left, the answer is "no box".
 * - A named apply button above the field that names the code is read as the
 *   field's own apply button after it (applyAfterField).
 * - A named apply button that fails the checks every clicked pick passes
 *   refuses the whole answer as `refused_button`, a toggle included. The
 *   extension reads a null button as "this box applies on Enter", and Enter
 *   in a field beside a checkout or rewards button can submit that control.
 */
function toCachedAnswer(
    answer: Answer,
    outline: string,
    mayBeCut: boolean,
): CachedAnswer {
    const tree = new Outline(outline)
    const clickedOk = (n: number | null, toggle: boolean) => {
        const line = tree.line(n)
        if (!line || !CLICK_ROLES.has(line.role)) return false
        const at = tree.byIndex.get(n!)!
        const name = controlWords(line)
        if (
            NEVER_CLICK.test(name) ||
            FORBIDDEN_CONTROL.test(name) ||
            noCodeClick(name) ||
            spendsPoints(tree, at)
        )
            return false
        // A toggle in the page footer ("Have A Code?" beside Gift Cards and
        // Contact Us) leads to another page, not to this cart's box. The
        // extension already refuses a link that leaves the page; this also
        // covers a footer control drawn as a script button, and keeps the
        // answer honest for the eval, which scores what the server returns.
        // Only the toggle: an apply button is never refused for where it sits.
        return !(
            toggle &&
            (tree.inPageFooter(at, mayBeCut) ||
                offersOnly(tree, at) ||
                settingControl(line))
        )
    }
    const inputLine = tree.line(answer.input)
    const input =
        inputLine &&
        INPUT_ROLES.has(inputLine.role) &&
        !pointsField(inputLine.name)
            ? answer.input
            : null
    const toggle = clickedOk(answer.toggle, true) ? answer.toggle : null
    if (input === null && toggle === null) {
        return {
            outcome: 'no_box',
            confidence: answer.confidence,
            why: answer.why,
        }
    }
    const button = applyAfterField(tree, answer.button, input)
    if (button !== null && !clickedOk(button, false))
        return { outcome: 'no_pick', reason: 'refused_button' }
    return {
        outcome: 'box',
        input,
        button,
        toggle,
        confidence: answer.confidence,
        why: answer.why,
    }
}

// Keyed by store and checked against the page (couponBoxPickAnswerCache.ts),
// not by a hash of the whole outline: that never repeated on a real store.
const cache = createCouponBoxAnswerCache<CachedAnswer>({
    ttlMs: 24 * 60 * 60 * 1000,
    maxStores: 2000,
})

/**
 * Pick the coupon box on one page outline.
 *
 * `admitModelCall` runs only on a cache MISS, immediately before the paid
 * model call, and may throw to refuse it (the route passes the coupon-box
 * budget, couponBoxPickBudget.ts); that refusal propagates. The eval harness
 * omits it — evals measure the model, not the budget.
 *
 * Never throws for a model failure: an error or an unusable reply is logged
 * to Sentry and answered as `no_pick`. Throws CouponBoxOutlineTooLargeError
 * for an outline over MAX_OUTLINE_BYTES (the route rejects those first).
 */
export async function pickCouponBox(
    request: CouponBoxPickRequest,
    admitModelCall?: () => Promise<void>,
): Promise<CouponBoxPickResult> {
    const bytes = Buffer.byteLength(request.outline, 'utf8')
    if (bytes > MAX_OUTLINE_BYTES)
        throw new CouponBoxOutlineTooLargeError(bytes)

    const model = env.COUPON_BOX_PICK_MODEL
    if (!model) return { outcome: 'no_pick', reason: 'disabled' }

    const outline = scrubOutline(request.outline)
    const hit = cache.get(request.domain, outline)
    if (hit) return { ...hit, cached: true }

    await admitModelCall?.()

    let raw: string
    try {
        raw = await chat(
            [
                { role: 'system', content: SYSTEM_PROMPT },
                {
                    role: 'user',
                    content: `Store: ${request.domain}\n\n${outline}`,
                },
            ],
            {
                model,
                temperature: 0,
                maxTokens: MAX_TOKENS,
                responseFormat: 'json_object',
                timeoutMs: TIMEOUT_MS,
                // Measured 2026-10-13 on a real cart: at the model's default
                // effort the route hit TIMEOUT_MS, and the same prompt sent
                // directly with no timeout reasoned through the whole
                // MAX_TOKENS and returned nothing after 32s; at low it
                // answered in ~60 tokens. A model swap must accept this
                // field: a provider that rejects it turns every pick into
                // no_pick, which the eval reports as red.
                reasoningEffort: 'low',
                // X-ORF-Strict pins the exact model on a relay that would
                // otherwise fall back to another free one; ignored by a
                // provider that does not know it. The paid-fallback headers
                // (Aladdin approved 2026-10-23, reversing the #346 rule that
                // kept the paid key off this guest-reachable route) let the
                // proxy answer on Caramel's own OpenRouter key when the free
                // host is slow or down. The spend is bounded three ways: the
                // daily model-call cap above (COUPON_BOX_PICK_DAILY_CAP), the
                // per-call budget, and the key's own $5/week limit at
                // OpenRouter. No key set = no headers, behaviour unchanged.
                // TIMEOUT_MS must stay at or above
                // MIN_PAID_PATH_DEADLINE_SECONDS, pinned by a test.
                headers: {
                    ...proxyFallbackHeaders(env.OPENROUTER_API_URL),
                    'X-ORF-Strict': '1',
                },
            },
        )
    } catch (error) {
        console.error('[coupon-box-pick] model call failed', error)
        // openrouter.ts aborts the fetch at TIMEOUT_MS: a slow upstream, not
        // a defect here, so a warning. The fingerprint groups by cause, not
        // by the minified stack frames, which change every build and reopened
        // the same timeout as a "new" issue each release (CARAMEL-27/2G/2Q/34,
        // T-7526).
        const timedOut = error instanceof Error && error.name === 'AbortError'
        Sentry.captureException(error, {
            level: timedOut ? 'warning' : 'error',
            tags: { surface: 'coupon-box-pick', operation: 'model_call' },
            fingerprint: [
                'coupon-box-pick',
                'model_call',
                timedOut ? 'timeout' : 'error',
            ],
            extra: { domain: request.domain, model, timeoutMs: TIMEOUT_MS },
        })
        return { outcome: 'no_pick', reason: 'model_error' }
    }

    const answer = parseAnswer(raw)
    if (!answer) {
        console.error('[coupon-box-pick] unusable model reply', {
            domain: request.domain,
            reply: raw.slice(0, RAW_REPLY_LOG_MAX),
        })
        Sentry.captureMessage('coupon-box-pick: unusable model reply', {
            level: 'warning',
            tags: { surface: 'coupon-box-pick', operation: 'parse' },
            fingerprint: ['coupon-box-pick', 'unusable-reply'],
            extra: {
                domain: request.domain,
                model,
                reply: raw.slice(0, RAW_REPLY_LOG_MAX),
            },
        })
        return { outcome: 'no_pick', reason: 'unparsable' }
    }

    const value = toCachedAnswer(
        answer,
        outline,
        bytes > MAX_OUTLINE_BYTES - NEAR_CAP_BYTES,
    )
    cache.set(
        request.domain,
        outline,
        value.outcome === 'box'
            ? [value.input, value.button, value.toggle].filter(
                  (n): n is number => n !== null,
              )
            : [],
        value,
    )
    return { ...value, cached: false }
}
