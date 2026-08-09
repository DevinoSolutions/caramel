/**
 * Money on the account page. Amounts arrive as integer minor units + an ISO
 * currency code so nothing rounds on the wire.
 *
 * Always two fraction digits: a lifetime total rendered as "$127" when the real
 * figure is $127.40 is a rounded claim about someone's money.
 */
export function formatMoney(minorUnits: number, currency: string): string {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(minorUnits / 100)
}

/**
 * "March 2026" — the month-and-year form used by "Saving with Caramel since …"
 * and the savings hero's "since …". Returns null for a missing or unparseable
 * timestamp so the caller drops the whole line instead of rendering
 * "since Invalid Date".
 */
export function formatMonthYear(iso: string | null | undefined): string | null {
    if (!iso) return null
    const parsed = Date.parse(iso)
    if (Number.isNaN(parsed)) return null
    return new Intl.DateTimeFormat('en-US', {
        month: 'long',
        year: 'numeric',
    }).format(new Date(parsed))
}

/**
 * Short date for a savings row ("12 Mar"), or the year too when the event is
 * from a previous calendar year. Returns null on an unparseable value — the
 * row then renders without a date rather than with a broken one.
 */
export function formatEventDate(iso: string): string | null {
    const parsed = Date.parse(iso)
    if (Number.isNaN(parsed)) return null
    const date = new Date(parsed)
    const sameYear = date.getFullYear() === new Date().getFullYear()
    return new Intl.DateTimeFormat('en-US', {
        day: 'numeric',
        month: 'short',
        ...(sameYear ? {} : { year: 'numeric' }),
    }).format(date)
}
