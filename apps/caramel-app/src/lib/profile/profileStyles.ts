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

/**
 * Warm-tinted PANEL that sits INSIDE a section card (pitch states, checklist,
 * teaching empty states). Deliberately flat — no shadow, no heavy border: a
 * shadowed card nested in another card is what made the old page read as a
 * pile of boxes rather than a layout.
 */
export const tintedPanelClasses =
    'rounded-xl border border-caramel/20 bg-gradient-to-br from-caramel/5 via-orange-50/30 to-caramel/5 p-6 dark:border-caramel/25 dark:from-caramel/10 dark:via-orange-900/10 dark:to-caramel/10 xs:p-4'

/** The identity band at the top of the page — one cohesive surface carrying
 * avatar, name, email, member-since AND the stat chips. Slightly richer than a
 * plain card because it is the page's subject. */
export const headerBandClasses =
    'overflow-hidden rounded-3xl border border-gray-100 bg-white shadow-lg dark:border-gray-800 dark:bg-darkerBg'

/**
 * One stat chip in the header band. A CHIP, not a tile: the old layout used
 * three big tiles in a 3-col grid, so hiding the savings tile when sync is off
 * left a visible hole where the third should be. Chips flow, so a missing one
 * closes up instead of leaving a gap.
 */
export const statChipClasses =
    'inline-flex items-baseline gap-1.5 rounded-full border border-gray-200 bg-gray-50/80 px-3.5 py-1.5 dark:border-gray-700 dark:bg-white/5'

export const statChipValueClasses =
    'text-base font-bold tabular-nums text-gray-900 dark:text-white'

export const statChipLabelClasses =
    'text-xs font-medium text-gray-600 dark:text-gray-400'

/**
 * The "turn on sync" teaser chip — an invitation, not a statistic, so it is
 * caramel-tinted and interactive rather than a neutral count.
 *
 * The label is `text-xs`, so it CANNOT use `text-caramel`: #ea6925 on a light
 * background measures 3.19:1 and is AA for large text only. `#a63f10` is the
 * darker end of the pair the auth panel already uses
 * (src/app/(auth)/layout.tsx) and clears AA at this size. On the dark surface
 * caramel itself measures ~5.9:1 and is fine.
 */
export const teaserChipClasses =
    'inline-flex items-center gap-1.5 rounded-full border border-caramel/30 bg-caramel/10 px-3.5 py-1.5 text-xs font-semibold text-[#a63f10] transition hover:bg-caramel/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel/50 dark:border-caramel/40 dark:bg-caramel/15 dark:text-caramel dark:hover:bg-caramel/25'

/**
 * PAGE SHELL — the fix for the account header rendering UNDER the sticky nav.
 *
 * `-mt-[6.7rem]` (107px) on <main> is the canonical opener every page uses to
 * pull content under the floating header. Pages with a hero re-add that space
 * themselves — PrivacyPageClient's first section carries `mt-[5rem]` on top of
 * its `py-16`, which is why it clears. This page had `py-16` (64px) alone, so
 * 43px of it sat behind the header on desktop and the whole identity card was
 * buried on a 390px phone, where the header is shorter but the negative margin
 * is not.
 *
 * These paddings re-add the 107px and then some, so the first card starts
 * BELOW the header pill on every viewport. Remember the screens are MAX-width:
 * unprefixed is desktop, `md:`/`xs:` step down for smaller screens.
 */
export const pageShellClasses = 'relative -mt-[6.7rem] w-full'
export const pageContainerClasses =
    'container mx-auto px-4 pb-20 pt-[10.5rem] md:pb-16 md:pt-[9rem] xs:px-3 xs:pb-12 xs:pt-[8.25rem]'

/** Section heading. text-2xl clears the 24px AA-large floor for text-caramel. */
export const sectionHeadingClasses =
    'text-2xl font-bold tracking-tight text-gray-900 dark:text-white md:text-xl'

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

// ---------------------------------------------------------------------------
// Section navigation
//
// POSITIONING NOTE — why the rail is `fixed` and not `sticky`:
// `position: sticky` DOES NOT WORK anywhere in this app. Layout.tsx wraps every
// page in `flex min-h-screen flex-col overflow-x-hidden`, and an ancestor with
// a non-visible overflow becomes the sticky scroll container; since that
// wrapper grows with its content and never scrolls internally, nothing inside
// it can ever stick. Measured, not assumed: on /privacy the app's OWN header
// (`sticky top-4`) scrolls from top 16 to top -1184 after a 1200px scroll.
// Fixing that belongs in Layout.tsx (`overflow-x: clip` keeps the same
// clipping without creating a scroll container) and would change the scrolled
// appearance of every page, so it is deliberately NOT done here.
//
// `position: fixed` is unaffected (there is no transform/filter ancestor), so
// the rail uses it.

/**
 * Desktop side rail — fixed, so it stays with the reader down a long page.
 *
 * The horizontal offset reproduces where the grid's first column sits: the
 * content grid is `max-w-5xl` (64rem) centred inside a `px-4` container, so its
 * left edge is `50vw - 32rem`, floored at the container's own 1rem padding for
 * viewports narrower than the grid. Widths verified at 1024/1100/1280/1536.
 */
export const navRailClasses =
    'fixed top-[10.5rem] left-[max(1rem,calc(50%_-_32rem))] flex w-52 flex-col gap-1'

export const navRailItemClasses =
    'rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors duration-200'

export const navRailItemActiveClasses =
    'bg-caramel/10 text-[#a63f10] dark:bg-caramel/15 dark:text-caramel'

export const navRailItemIdleClasses =
    'text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-white'

/**
 * Small-screen chip row: a scrollable table of contents above the first card.
 *
 * In flow rather than pinned — see the positioning note above; a pinned bar
 * would need `fixed`, and a fixed bar at the top of a phone viewport collides
 * with the floating header pill at rest. Bleeding to the screen edges
 * (`-mx-4` against the container's `px-4`) is what makes the overflow read as
 * scrollable instead of clipped.
 */
export const navChipBarClasses =
    '-mx-4 mb-6 hidden overflow-x-auto px-4 pb-1 lg:block xs:-mx-3 xs:px-3'

export const navChipClasses =
    'shrink-0 whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors duration-200'

export const navChipActiveClasses = 'bg-caramel text-white shadow-caramel-sm'

export const navChipIdleClasses =
    'bg-gray-100 text-gray-700 dark:bg-white/5 dark:text-gray-300'

/**
 * Scroll offset for every section heading, so a jump (rail click, chip tap, or
 * a `/profile#savings` deep link) lands the heading a comfortable distance
 * below the top edge rather than flush against it.
 */
export const sectionScrollOffsetClasses = 'scroll-mt-24 lg:scroll-mt-20'

/** The header row inside a section card: title/description left, control right,
 * separated from the body by a rule so the two read as one card rather than
 * two floating columns. */
export const sectionHeaderRowClasses =
    'flex items-start justify-between gap-6 border-b border-gray-100 pb-4 dark:border-gray-800 md:flex-col md:gap-3'
