/**
 * One source of truth for auth-form styling.
 *
 * These exact class strings previously existed twice, character-for-character,
 * in LoginPageClient and SignupPageClient. Two copies is how the two pages drift
 * apart, and adding /forgot-password and /reset-password would have made four.
 * Any visual change to auth inputs now happens here once.
 */

export const inputClasses =
    'w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-gray-900 shadow-sm transition duration-200 placeholder:text-gray-400 hover:border-gray-400 focus:border-caramel focus:outline-none focus:ring-2 focus:ring-caramel/30 dark:border-gray-700 dark:bg-darkBg dark:text-gray-100 dark:shadow-none dark:placeholder:text-gray-500 dark:hover:border-gray-600 dark:focus:border-caramel'

/** Same as `inputClasses` but leaves room for the trailing reveal button. */
export const inputWithAffordanceClasses = `${inputClasses} pr-12`

export const labelClasses =
    'mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300'

export const socialButtonClasses =
    'flex w-full items-center justify-center gap-3 rounded-xl border border-gray-300 bg-white px-4 py-3 font-medium text-gray-700 shadow-sm transition duration-200 hover:border-caramel hover:bg-caramel/5 active:bg-caramel/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel/50 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-darkBg dark:text-gray-200 dark:shadow-none dark:hover:border-caramel/60 dark:hover:bg-caramel/10 dark:active:bg-caramel/15 dark:focus-visible:ring-offset-darkerBg'

export const primaryButtonClasses =
    'w-full rounded-xl bg-caramel py-3 font-semibold text-white shadow-sm transition duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel focus-visible:ring-offset-2 enabled:hover:bg-caramel/90 enabled:hover:shadow-caramel-sm enabled:active:bg-caramel disabled:cursor-not-allowed disabled:opacity-60 dark:focus-visible:ring-offset-darkerBg'

export const linkClasses =
    'rounded-sm font-semibold text-caramel underline-offset-2 transition hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel/50'

export const fieldErrorClasses = 'mt-1.5 text-sm text-red-600 dark:text-red-400'
