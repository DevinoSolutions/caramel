package com.devino.caramel.web

/**
 * The sign-in loop cap (T-10055), the Android twin of the iOS shell's SignInLoopCoordinator cap. Pure
 * (JVM-testable): the caller passes the clock.
 *
 * Every automatic sign-in request (the WebView heading for /login or /signup, through
 * [ShellHost.interceptSignInRoute]) is counted over a sliding [WINDOW_MILLIS]; the request past
 * [MAX_AUTOMATIC_REQUESTS] PARKS the shell. A parked shell shows "sign in" and does nothing on its own:
 * no native prompt, no handoff, no home load posted after a /login history change, and every main-frame
 * navigation is cancelled. Without this, a page that keeps routing itself to /login made the client post
 * a home load per lap, forever. Only an explicit tap by the shopper ([userTapped]) unparks: time does not,
 * and neither does a WebView reset (CaramelApp keeps one guard across WebView generations). 4 because a
 * shopper needs at most one or two, and every real request waits on a person through a sign-in sheet.
 */
class SignInLoopGuard {
    enum class Admission {
        /** Handle the request as usual. */
        ADMITTED,

        /** This request crossed the cap: the shell parks now (report it, once). */
        PARKED_NOW,

        /** Already parked: do nothing automatic. */
        PARKED,
    }

    var isParked: Boolean = false
        private set

    private val requestTimes = mutableListOf<Long>()

    /** Counts one automatic sign-in request at [nowMillis] (a monotonic clock). */
    fun automaticSignInRequest(nowMillis: Long): Admission {
        if (isParked) return Admission.PARKED
        requestTimes.removeAll { nowMillis - it >= WINDOW_MILLIS }
        requestTimes.add(nowMillis)
        if (requestTimes.size <= MAX_AUTOMATIC_REQUESTS) return Admission.ADMITTED
        isParked = true
        requestTimes.clear()
        return Admission.PARKED_NOW
    }

    /** Whether a navigation or load the shopper did not tap for may run: false while parked. */
    fun admitsAutomaticNavigation(): Boolean = !isParked

    /** The shopper tapped (Sign in, Try again, a tab, a retry banner): unpark and start the count over. Call BEFORE the tap's own load. */
    fun userTapped() {
        isParked = false
        requestTimes.clear()
    }

    companion object {
        const val WINDOW_MILLIS = 60_000L
        const val MAX_AUTOMATIC_REQUESTS = 4
    }
}
