package com.devino.caramel.web

import com.devino.caramel.core.ApiError
import com.devino.caramel.core.CaramelApi
import com.devino.caramel.core.SessionStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.IOException

/**
 * The native-to-web session handoff (T-7852). The WebView cannot use the native session bearer for
 * page loads, so the shell trades it (POST /api/app/web-session/handoff) for a one-time redeem URL
 * and loads that URL through `loadGuarded`; the server answers with the signed session cookie and a
 * 303 to the `next` path. The code in the URL is a credential: nothing in this file logs it.
 */

/** The `next` paths POST /api/app/web-session/handoff accepts, and the pages a redeem may land on. */
object HandoffNext {
    private const val ROOT = "/"
    private const val MAX_LENGTH = 512

    // Mirrors ALLOWED_NEXT_PREFIXES in apps/caramel-app/src/app/api/app/web-session/handoff/route.ts.
    private val allowedPrefixes = listOf("/coupons", "/profile", "/welcome")

    /**
     * The `next` to send for a tab or page that wants [path] (such as "/profile#favorites"): [path]
     * itself when the server will accept it, otherwise "/". Stricter than the server on purpose:
     * escapes, dot segments and a leading "//" are never sent.
     */
    fun forPath(path: String?): String {
        if (path == null || path.length > MAX_LENGTH || !path.startsWith("/") || path.startsWith("//")) return ROOT
        if (AppLinkGuard.targetForStartPath(path) == null) return ROOT
        val rawPath = path.substringBefore('#').substringBefore('?')
        if ('%' in rawPath || rawPath.split('/').any { it == "." || it == ".." }) return ROOT
        return if (allowedPrefixes.any { isUnder(rawPath, it) }) path else ROOT
    }

    /** Whether a [ShellRoutes.normalizedPath] is a page a redeem may land on: the home page or an allowed prefix. */
    fun isAllowlistedLanding(normalizedPath: String): Boolean =
        normalizedPath == ROOT || allowedPrefixes.any { isUnder(normalizedPath, it) }

    private fun isUnder(path: String, prefix: String): Boolean = path == prefix || path.startsWith("$prefix/")
}

/** The redeem URL the handoff route returns; only this exact shape may be loaded as a handoff. */
object RedeemUrl {
    const val PATH = "/api/app/web-session/redeem"

    // The server mints 32 random bytes as base64url: always 43 characters.
    private const val CODE_LENGTH = 43

    /** True for an AppLinkGuard-approved URL that reads as the redeem route (any query), however it is spelled. */
    fun hasRedeemPath(url: String?): Boolean {
        val allowed = AppLinkGuard.allowedTarget(url) ?: return false
        return ShellRoutes.normalizedPath(allowed) == PATH
    }

    /** True for exactly `https://grabcaramel.com/api/app/web-session/redeem?code=<43 base64url characters>`: no other query, no fragment. */
    fun matches(url: String?): Boolean {
        val allowed = AppLinkGuard.allowedTarget(url) ?: return false
        val rest = allowed.removePrefix(AppLinkGuard.APP_ORIGIN)
        if (!rest.startsWith("$PATH?code=")) return false
        val code = rest.removePrefix("$PATH?code=")
        return code.length == CODE_LENGTH && code.all { it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '-' || it == '_' }
    }
}

/**
 * The web session cookie the redeem route sets (better-auth's, `__Secure-` prefixed because the site is https). Its presence in
 * the WebView's cookie jar after the redeem landed is the proof the handoff worked; landing on an allowlisted page alone is not.
 */
object WebSessionCookie {
    const val NAME = "__Secure-better-auth.session_token"

    /** [cookieHeader] is `CookieManager.getCookie(origin)`: "a=1; b=2". Never log it. */
    fun isPresent(cookieHeader: String?): Boolean {
        if (cookieHeader == null) return false
        return cookieHeader.split(';').any {
            val pair = it.trim()
            pair.startsWith("$NAME=") && pair.length > NAME.length + 1
        }
    }
}

/** When the WebView's copy of the web session must be wiped, decided from the native session bearer's identity. */
object WebSessionLifecycle {
    /**
     * True when a token that was there is gone ([previousToken] to null) or replaced by another one (A to B,
     * which skips null when a new sign-in lands while the old token is still set). False at launch
     * (null to a token) and when the token is unchanged. The tokens are only compared, never logged.
     */
    fun shouldWipeWebSession(previousToken: String?, currentToken: String?): Boolean =
        previousToken != null && previousToken != currentToken

    /** After a wipe, a token that is still present (A to B) belongs to a new sign-in that needs its own handoff. */
    fun shouldRelinkAfterWipe(currentToken: String?): Boolean = currentToken != null
}

/** What asking the server for a redeem URL came to. */
sealed interface RedeemRequest {
    data class Url(val url: String) : RedeemRequest

    /** HTTP 401: the native session is dead. */
    data object SessionExpired : RedeemRequest

    /** Offline, timeout, 4xx/5xx other than 401, or an answer that is not a usable redeem URL. */
    data class Failed(val message: String) : RedeemRequest
}

class WebSessionHandoffClient(private val api: CaramelApi) {
    /**
     * Asks for a redeem URL that lands on [targetPath] (mapped through [HandoffNext.forPath]). The
     * returned URL has been checked by [RedeemUrl.matches], so it passes AppLinkGuard and has the
     * redeem path. Failure messages carry the status and request id, never the response body (it
     * may hold the code).
     */
    suspend fun requestRedeemUrl(bearer: String, targetPath: String?): RedeemRequest {
        val response = try {
            api.webSessionHandoff(bearer, HandoffNext.forPath(targetPath))
        } catch (e: ApiError) {
            return when {
                e.isUnauthorized -> RedeemRequest.SessionExpired
                e.status != null -> RedeemRequest.Failed("$FAILURE_PREFIX (HTTP ${e.status}) [request ${e.requestId}]")
                e.cause is IOException -> RedeemRequest.Failed("$FAILURE_PREFIX (no connection or timed out) [request ${e.requestId}]")
                else -> RedeemRequest.Failed("$FAILURE_PREFIX (unexpected response) [request ${e.requestId}]")
            }
        }
        if (!RedeemUrl.matches(response.url)) {
            return RedeemRequest.Failed("$FAILURE_PREFIX (the server returned an address the app will not open)")
        }
        return RedeemRequest.Url(response.url)
    }

    private companion object {
        const val FAILURE_PREFIX = "Could not link your sign-in to the web pages"
    }
}

/** What a caller does after a handoff attempt. */
sealed interface HandoffStep {
    /** Load [redeemUrl] (through the guarded sink); [WebSessionHandoff.onPageVisited] confirms the landing. */
    data class Load(val redeemUrl: String) : HandoffStep

    /** The native session is dead (or absent): the shopper must sign in natively. */
    data object SignInRequired : HandoffStep

    /** Shown through [WebSessionHandoff.failure]; nothing was loaded. */
    data class Failed(val message: String) : HandoffStep

    /** A newer tap, a sign-out or a reset overtook this request; its result was dropped. */
    data object Superseded : HandoffStep
}

/** What to do with a /login visit while the app is signed in natively. */
sealed interface LoginBounceOutcome {
    /** A handoff request is already running; the bounce belongs to the page it replaces. */
    data object Ignore : LoginBounceOutcome

    /** The one automatic retry was already spent: stop, show the native sign-in. */
    data object NativeSignIn : LoginBounceOutcome

    /** The one automatic retry ran. */
    data class Retried(val step: HandoffStep) : LoginBounceOutcome
}

/**
 * Owns whether the WebView holds a web session that mirrors the native sign-in ([active]) and the
 * no-loop rules around getting one. Main thread only. [hasSessionCookie] reads the WebView's cookie jar.
 *
 * Rules:
 * - The latest user action wins: [startFresh] and any other load ([admitLoad]) cancel a running request.
 * - [active] turns true only when the redeem URL this class issued landed on an allowlisted path AND the
 *   session cookie is in the jar. A load error, a /login landing or a landing without the cookie never activates.
 * - A /login visit while signed in natively ([retryAfterLoginBounce]), whether or not [active] was true, marks
 *   the web session inactive and starts at most ONE automatic handoff; the next bounce falls back to native
 *   sign-in. It never ends the native session: only a 401 does that.
 */
class WebSessionHandoff(
    private val client: WebSessionHandoffClient,
    private val session: SessionStore,
    private val hasSessionCookie: () -> Boolean,
) {
    private val mutableFailure = MutableStateFlow<String?>(null)

    /** The last handoff failure for the shell's retry banner, or null. */
    val failure: StateFlow<String?> = mutableFailure.asStateFlow()

    /** Whether the WebView holds a web session for the native sign-in. Process memory only: false again after a restart. */
    var active: Boolean = false
        private set

    // A handoff request is running.
    private var requesting = false

    // The redeem URL handed to the WebView that has not landed yet; the only redeem URL admitLoad lets through, once.
    private var issuedRedeemUrl: String? = null
    private var redeemInFlight = false

    // The one automatic handoff after a bounce has been spent.
    private var retryUsed = false

    // Bumped by cancelPending(), so a request that finishes after being overtaken is dropped.
    private var generation = 0

    /** A user-initiated handoff to [targetPath]; it overtakes any running request. */
    suspend fun startFresh(targetPath: String?): HandoffStep {
        cancelPending()
        requesting = true
        retryUsed = false
        mutableFailure.value = null
        return run(targetPath)
    }

    /**
     * The WebView went to /login while signed in natively (the shell cancelled that navigation).
     * Everything that changes state happens before the first suspension, so a caller that starts this
     * undispatched can never leave a permit behind, and a cancelled call releases it in `finally`.
     */
    suspend fun retryAfterLoginBounce(targetPath: String?): LoginBounceOutcome {
        if (requesting) return LoginBounceOutcome.Ignore
        active = false
        redeemInFlight = false
        issuedRedeemUrl = null
        // Stays spent after the fallback: only a user-initiated handoff (startFresh) or a verified landing re-arms it.
        if (retryUsed) return LoginBounceOutcome.NativeSignIn
        retryUsed = true
        requesting = true
        mutableFailure.value = null
        return LoginBounceOutcome.Retried(run(targetPath))
    }

    /**
     * Call before the shell's guarded sink loads [url] (tabs, intents, the shell's own loads). False means do
     * not load it: it reads as the redeem route but is not the one URL issued. A page's own navigation never
     * comes through here; the WebView client refuses those ([NavigationPolicy.isPageInitiatedRedeem]). Any
     * other load cancels a running request and stops waiting for a redeem to land.
     */
    fun admitLoad(url: String): Boolean {
        if (url == issuedRedeemUrl) {
            issuedRedeemUrl = null // single use: a reload of it would only meet "handoff_expired"
            return true
        }
        if (RedeemUrl.hasRedeemPath(url)) return false
        cancelPending()
        return true
    }

    /** The WebView reached [url] (any visit). Decides whether an in-flight redeem proved the web session. */
    fun onPageVisited(url: String) {
        if (!redeemInFlight) return
        val allowed = AppLinkGuard.allowedTarget(url)
        if (allowed == null) {
            redeemInFlight = false // left the site: this redeem is over
            return
        }
        val path = ShellRoutes.normalizedPath(allowed) ?: return
        if (path == RedeemUrl.PATH) return // the redeem itself; its 303 is still coming
        redeemInFlight = false
        if (!HandoffNext.isAllowlistedLanding(path)) return // /login and the like: not linked
        if (hasSessionCookie()) {
            active = true
            retryUsed = false
        } else {
            mutableFailure.value = LANDED_WITHOUT_COOKIE
        }
    }

    /** The main frame failed to load: an in-flight redeem is over and proved nothing. */
    fun onLoadFailed() {
        redeemInFlight = false
        issuedRedeemUrl = null
    }

    /** Cancels a running request and forgets an in-flight redeem. Does not touch [active]. */
    fun cancelPending() {
        generation += 1
        requesting = false
        redeemInFlight = false
        issuedRedeemUrl = null
    }

    /** Sign-out or the native session ending: the WebView's web session is gone. */
    fun reset() {
        cancelPending()
        active = false
        retryUsed = false
        mutableFailure.value = null
    }

    fun dismissFailure() {
        mutableFailure.value = null
    }

    private suspend fun run(targetPath: String?): HandoffStep {
        val started = generation
        // Any new handoff re-links from scratch: a web session left over from an earlier sign-in must not count.
        active = false
        redeemInFlight = false
        issuedRedeemUrl = null
        try {
            val bearer = session.token ?: return HandoffStep.SignInRequired
            val request = client.requestRedeemUrl(bearer, targetPath)
            // Overtaken by a newer tap or a reset, or the native session ended meanwhile (a late answer must not load for nobody).
            if (started != generation || session.token != bearer) return HandoffStep.Superseded
            return when (request) {
                is RedeemRequest.Url -> {
                    issuedRedeemUrl = request.url
                    redeemInFlight = true
                    HandoffStep.Load(request.url)
                }
                RedeemRequest.SessionExpired -> {
                    session.endExpiredSession()
                    HandoffStep.SignInRequired
                }
                is RedeemRequest.Failed -> {
                    mutableFailure.value = request.message
                    HandoffStep.Failed(request.message)
                }
            }
        } finally {
            if (started == generation) requesting = false
        }
    }

    private companion object {
        const val LANDED_WITHOUT_COOKIE = "Could not link your sign-in to the web pages (the page opened without a session)"
    }
}
