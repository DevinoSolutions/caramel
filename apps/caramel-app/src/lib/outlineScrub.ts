// src/lib/outlineScrub.ts
//
// What the coupon-box pick may read of a page outline (couponBoxPick.ts): every
// digit becomes `#`, anything email-shaped `[email]`, and any code-shaped token
// `[code]` (T-9959). Pure and import-free beyond codeShapedTokens.ts, with
// RELATIVE imports only, because the extension's background bundles this same
// file and runs it before the outline leaves the browser (T-10427); the server
// runs it again on arrival for older builds.
import { redactCodeShapedTokens, stripFormatChars } from './codeShapedTokens'

// Bounded runs: with open-ended ones, a long word with no "@" (an outline is
// guest-written) makes every start scan to the end of the line, and a 40 KiB
// line took seconds. An address's local part is at most 64 characters, a
// domain at most 253.
const EMAIL_SHAPED = /[\w.+-]{1,64}@[\w-]{1,253}\.[\w.]{1,253}/g
// A node line's leading `- [n] role` head. Its index is the only number the
// outline may keep, and only when a role word follows it: a line of page text
// that happens to start like an index is scrubbed like any other text.
const NODE_HEAD = /^\s*- \[(\d{1,6})\] (?=[a-z]+\b)/
// Every line break a browser can put in an accessible name, not only \n:
// CR LF, LF, CR and the two Unicode separators (U+2028, U+2029), built from
// their code points so no tool can turn the escape into the raw character.
const LINE_BREAK = new RegExp(
    `\r\n|[\n\r${String.fromCharCode(0x2028, 0x2029)}]`,
)

// Any Unicode number (\p{N}), not just 0-9: a phone number in Arabic-Indic,
// Persian or fullwidth digits is still a phone number. Built with the
// constructor because this project's compile target rejects the literal `u`
// flag; every runtime we run on supports it.
const ANY_DIGIT = new RegExp('\\p{N}', 'gu')
// Order matters: invisible format characters go first (they would split an
// address or a code), then emails (a code-shaped local part would otherwise break
// the address into something EMAIL_SHAPED no longer matches), then tokens that
// mix letters and digits, or letters and the extension's own `#` mask ("Remove
// SAVE10" / "Remove SAVE##" is an applied-code chip: it must not survive as
// "SAVE#"; old extension builds keep sending it), then the digits.
function scrubText(text: string): string {
    return redactCodeShapedTokens(
        stripFormatChars(text).replace(EMAIL_SHAPED, '[email]'),
    ).replace(ANY_DIGIT, '#')
}

/** Every digit becomes `#`, anything email-shaped becomes `[email]` and any
 * token mixing letters and digits becomes `[code]`, except the `[n]` index at
 * the start of a node line (the extension maps the pick back through it). */
export function scrubOutline(outline: string): string {
    return outline
        .split(LINE_BREAK)
        .map(line => {
            const head = NODE_HEAD.exec(line)?.[0] ?? ''
            return head + scrubText(line.slice(head.length))
        })
        .join('\n')
}
