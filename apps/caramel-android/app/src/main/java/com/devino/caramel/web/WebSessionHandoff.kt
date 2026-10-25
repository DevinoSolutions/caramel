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

/** The redeem URL the handoff route returns; only this exact address may be loaded as a handoff. */
object RedeemUrl {
    const val PATH = "/api/app/web-session/redeem"

    /** True for an AppLinkGuard-approved URL whose path is exactly [PATH], with a non-empty `code` query and no fragment. */
    fun matches(url: String?): Boolean {
        val allowed = AppLinkGuard.allowedTarget(url) ?: return false
        val rest = allowed.removePrefix(AppLinkGuard.APP_ORIGIN)
        if ('#' in rest) return false
        val query = rest.substringAfter('?', "")
        return rest.substringBefore('?') == PATH && query.startsWith("code=") && query.length > "code=".length
    }
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

    /** Another handoff request is already running; this call did nothing. */
    data object Busy : HandoffStep

    /** The web session was reset (sign-out, deletion) while the request ran; the result was dropped. */
    data object Superseded : HandoffStep
}

/** What to do with a /login visit while the app is signed in natively and the WebView has no web session. */
enum class LoginBounceDecision {
    /** A handoff request is already running; the bounce belongs to the page it replaces. */
    IGNORE,

    /** First bounce: request one fresh handoff (the permit is already held; call [WebSessionHandoff.continueRetry]). */
    RETRY_HANDOFF,

    /** The retry already failed too: stop, show the native sign-in. */
    NATIVE_SIGN_IN,
}

/**
 * Owns whether the WebView holds a web session that mirrors the native sign-in ([active]) and the
 * no-loop rules around getting one. Main thread only.
 *
 * Rules: a user-initiated handoff ([startFresh]: sign-in completed, a tab that needs the session)
 * gets a clean slate; if the WebView then bounces to /login (including `/login?error=handoff_expired`
 * from a failed redeem) exactly ONE automatic handoff follows; a second bounce falls back to native
 * sign-in. [active] turns true only when a redeemed page lands on an allowlisted path.
 */
class WebSessionHandoff(
    private val client: WebSessionHandoffClient,
    private val session: SessionStore,
) {
    private val mutableFailure = MutableStateFlow<String?>(null)

    /** The last handoff failure for the shell's retry banner, or null. */
    val failure: StateFlow<String?> = mutableFailure.asStateFlow()

    /** Whether the WebView holds a web session for the native sign-in. Process memory only: false again after a restart. */
    var active: Boolean = false
        private set

    // A handoff request is running (or its retry was granted by onLoginWhileUnlinked).
    private var requesting = false

    // A redeem URL was handed to the WebView and has not landed yet.
    private var redeemInFlight = false

    // The one automatic handoff after a bounce has been spent.
    private var retryUsed = false

    // Bumped by reset(), so a request that finishes after a sign-out is dropped.
    private var epoch = 0

    /** A user-initiated handoff to [targetPath]; Busy when one is already running. */
    suspend fun startFresh(targetPath: String?): HandoffStep {
        if (requesting) return HandoffStep.Busy
        requesting = true
        retryUsed = false
        mutableFailure.value = null
        return run(targetPath)
    }

    /** The WebView went to /login while signed in natively without a web session (decides retry vs native sign-in). */
    fun onLoginWhileUnlinked(): LoginBounceDecision {
        if (requesting) return LoginBounceDecision.IGNORE
        redeemInFlight = false
        // Stays spent after the fallback: only a user-initiated handoff (startFresh) or a landing re-arms it.
        if (retryUsed) return LoginBounceDecision.NATIVE_SIGN_IN
        retryUsed = true
        requesting = true
        mutableFailure.value = null
        return LoginBounceDecision.RETRY_HANDOFF
    }

    /** Runs the handoff [onLoginWhileUnlinked] granted. */
    suspend fun continueRetry(targetPath: String?): HandoffStep {
        check(requesting) { "continueRetry needs the RETRY_HANDOFF permit from onLoginWhileUnlinked" }
        return run(targetPath)
    }

    /** The WebView reached [url] (any visit). Confirms an in-flight redeem once it lands on an allowlisted page. */
    fun onPageVisited(url: String) {
        if (!redeemInFlight) return
        val allowed = AppLinkGuard.allowedTarget(url) ?: return
        val path = ShellRoutes.normalizedPath(allowed) ?: return
        if (HandoffNext.isAllowlistedLanding(path)) {
            redeemInFlight = false
            active = true
            retryUsed = false
        }
    }

    /** Something other than a redeem is being loaded: a landing after this no longer proves the redeem worked. */
    fun abandonInFlight() {
        redeemInFlight = false
    }

    /** Sign-out or account deletion: the WebView's web session is gone. */
    fun reset() {
        epoch += 1
        active = false
        requesting = false
        redeemInFlight = false
        retryUsed = false
        mutableFailure.value = null
    }

    fun dismissFailure() {
        mutableFailure.value = null
    }

    private suspend fun run(targetPath: String?): HandoffStep {
        val startedEpoch = epoch
        // Any new handoff re-links from scratch: a web session left over from an earlier sign-in must not count.
        active = false
        redeemInFlight = false
        try {
            val bearer = session.token ?: return HandoffStep.SignInRequired
            val request = client.requestRedeemUrl(bearer, targetPath)
            if (epoch != startedEpoch) return HandoffStep.Superseded
            return when (request) {
                is RedeemRequest.Url -> {
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
            if (epoch == startedEpoch) requesting = false
        }
    }
}
