/**
 * One source of truth for account-page styling — same reason authStyles.ts
 * exists (see its header): the section cards, tiles and danger controls below
 * each appear in three or more section files, and three copies is how they
 * drift. Any visual change to the account page happens here once.
 *
 * CONTRAST NOTE (do not "simplify" these): #ea6925 on white measures 3.19:1,
 * which is AA for LARGE text only (>=24px, or >=18.66px bold). Every caramel
 * text token below is therefore attached to a >=text-2xl/3xl class. Body copy
 * is gray-700/gray-300 on purpose.
 *
 * BREAKPOINT NOTE: this app's Tailwind screens are MAX-widths
 * (tailwind.config.ts) — unprefixed is the DESKTOP style and `md:`/`xs:` are
 * the small-screen overrides. `p-8 md:p-6 xs:p-5` shrinks on phones; it does
 * not grow on desktop.
 */

/** The standard raised card. Matches the existing profile card + header dropdown. */
export const cardClasses =
    'rounded-2xl border border-gray-100 bg-white p-8 shadow-lg dark:border-gray-800 dark:bg-darkerBg md:p-6 xs:p-5'

/** Warm-tinted card for sections that pitch rather than report (checklist, sync pitch). */
export const tintedCardClasses =
    'rounded-2xl border border-caramel/20 bg-gradient-to-br from-caramel/5 via-orange-50/20 to-caramel/5 p-8 shadow-md dark:border-caramel/30 dark:from-caramel/10 dark:via-orange-900/10 dark:to-caramel/10 md:p-6 xs:p-5'

/** Section heading. text-2xl clears the 24px AA-large floor for text-caramel. */
export const sectionHeadingClasses =
    'text-2xl font-bold tracking-tight text-gray-900 dark:text-white'

export const sectionDescriptionClasses =
    'mt-1 text-sm leading-relaxed text-gray-600 dark:text-gray-400'

/** Sub-heading inside a section card (Export, Danger zone) — always an <h3>. */
export const subHeadingClasses =
    'text-lg font-semibold text-gray-900 dark:text-white'

/** Body copy. gray-700 on white = 10.3:1; gray-300 on darkerBg = 11.4:1. */
export const bodyTextClasses =
    'text-sm leading-relaxed text-gray-700 dark:text-gray-300'

/** Secondary button — the auth social button minus its icon layout. */
export const secondaryButtonClasses =
    'inline-flex items-center justify-center gap-2 rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 shadow-sm transition duration-200 hover:border-caramel hover:bg-caramel/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel/50 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-darkBg dark:text-gray-200 dark:shadow-none dark:hover:border-caramel/60 dark:hover:bg-caramel/10 dark:focus-visible:ring-offset-darkerBg'

/** Destructive button. Red-700 on white = 4.8:1; red-300 on darkBg = 6.4:1. */
export const dangerButtonClasses =
    'inline-flex items-center justify-center gap-2 rounded-xl border border-red-300 bg-white px-4 py-2.5 text-sm font-semibold text-red-700 shadow-sm transition duration-200 hover:border-red-500 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-900/60 dark:bg-darkBg dark:text-red-300 dark:shadow-none dark:hover:bg-red-950/40 dark:focus-visible:ring-offset-darkerBg'

/** The fence around the delete control. Deliberately not a card — it should
 * read as a different, more dangerous surface than everything above it. */
export const dangerFenceClasses =
    'rounded-2xl border border-red-200 bg-red-50/50 p-6 dark:border-red-900/50 dark:bg-red-950/20 xs:p-5'

/** Rows inside a list card. Last row drops its divider. */
export const listRowClasses =
    'flex items-center gap-4 border-b border-gray-100 py-4 first:pt-0 last:border-b-0 last:pb-0 dark:border-gray-800'

/** Monospace code chip — the coupon code in a savings row. */
export const codeChipClasses =
    'rounded-md bg-gray-100 px-2 py-0.5 font-mono text-xs font-semibold tracking-wide text-gray-700 dark:bg-white/10 dark:text-gray-200'

/** The uppercase micro-label idiom already used by the profile card and
 * FeaturesSection. gray-500 on white = 4.6:1; on dark it MUST step to
 * gray-400 (gray-500 on darkerBg is 3.5:1 and fails). */
export const microLabelClasses =
    'text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400'

/** Inline notice — the same alert idiom LoginPageClient uses. */
export const noticeClasses =
    'rounded-xl border border-orange-300 bg-orange-50 p-4 dark:border-caramel/40 dark:bg-caramel/10'

export const noticeTitleClasses =
    'text-sm font-semibold text-orange-800 dark:text-orange-200'

export const noticeBodyClasses =
    'mt-1 text-sm text-orange-700 dark:text-orange-300'

/** The notice's own button (LoginPageClient's verification-alert button). */
export const noticeButtonClasses =
    'mt-3 rounded-lg border border-orange-300 bg-white px-4 py-2 text-sm font-semibold text-caramel shadow-sm transition duration-200 hover:bg-orange-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel/50 focus-visible:ring-offset-2 dark:border-caramel/40 dark:bg-darkBg dark:shadow-none dark:hover:bg-caramel/10 dark:focus-visible:ring-offset-darkerBg'

/** Focus ring for a non-button interactive (the favorites row Link). Buttons
 * get theirs free from globals.css — do not add a competing ring there. */
export const linkRowFocusClasses =
    'rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel focus-visible:ring-offset-2 dark:focus-visible:ring-offset-darkerBg'
