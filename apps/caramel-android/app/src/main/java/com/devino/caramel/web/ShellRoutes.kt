package com.devino.caramel.web

/** The bottom tabs; each one is a grabcaramel.com route shown in the WebView. */
enum class ShellTab(val label: String, val startPath: String) {
    DEALS("Deals", "/coupons"),
    SEARCH("Search", "/coupons/stores"),
    SAVED("Saved", "/profile#favorites"),
    ACCOUNT("Account", "/profile"),
}

/** What the shell does when the WebView heads for /login or /signup. */
enum class AuthAction {
    /** Not a sign-in route: let the WebView load it. */
    NONE,

    /** Signed out natively: show the native sign-in (Google blocks OAuth inside a WebView). */
    START_NATIVE_SIGN_IN,

    /** The web session ended while the app still holds a token: drop the token, then sign in again. */
    SIGN_OUT_NATIVE_THEN_SIGN_IN,

    /** Signed in natively but the WebView has no web session yet (T-7852): say so, do not loop. */
    WEB_SESSION_UNAVAILABLE,
}

/** Pure route logic for the shell (JVM-testable). Every function takes the URL string the WebView reports. */
object ShellRoutes {
    fun urlFor(tab: ShellTab): String =
        checkNotNull(AppLinkGuard.targetForStartPath(tab.startPath)) { "tab ${tab.name} has an invalid start path" }

    fun homeUrl(): String = urlFor(ShellTab.DEALS)

    /** The privacy policy, loaded in the WebView through the same guard as every other URL. */
    fun privacyUrl(): String =
        checkNotNull(AppLinkGuard.targetForStartPath("/privacy")) { "the privacy path is not on the app origin" }

    /** The tab a URL belongs to, or null when it belongs to none (the selection then stays). */
    fun tabFor(url: String?): ShellTab? {
        val allowed = AppLinkGuard.allowedTarget(url) ?: return null
        val path = pathOf(allowed)
        val fragment = allowed.substringAfter('#', "")
        return when {
            path == "/profile" || path.startsWith("/profile/") ->
                if (fragment == "favorites") ShellTab.SAVED else ShellTab.ACCOUNT
            path == "/coupons/stores" || path.startsWith("/coupons/stores/") -> ShellTab.SEARCH
            path == "/coupons" || path.startsWith("/coupons/") -> ShellTab.DEALS
            else -> null
        }
    }

    fun isSignInRoute(url: String?): Boolean {
        val allowed = AppLinkGuard.allowedTarget(url) ?: return false
        return when (pathOf(allowed).trimEnd('/')) {
            "/login", "/signup" -> true
            else -> false
        }
    }

    /**
     * What to do with a navigation to [url]. [webSessionActive] is true only once the native
     * sign-in has been handed to the WebView (TODO(T-7852), see AppContainer.webSessionActive);
     * until then a /login visit while signed in is the web page lacking a session, not a sign-out.
     */
    fun authAction(url: String?, nativeSignedIn: Boolean, webSessionActive: Boolean): AuthAction = when {
        !isSignInRoute(url) -> AuthAction.NONE
        !nativeSignedIn -> AuthAction.START_NATIVE_SIGN_IN
        webSessionActive -> AuthAction.SIGN_OUT_NATIVE_THEN_SIGN_IN
        else -> AuthAction.WEB_SESSION_UNAVAILABLE
    }

    /** The path of an [AppLinkGuard]-approved URL, "/" when there is none. */
    private fun pathOf(allowed: String): String {
        val rest = allowed.removePrefix(AppLinkGuard.APP_ORIGIN).substringBefore('#').substringBefore('?')
        return rest.ifEmpty { "/" }
    }
}

/** What an incoming intent asks the shell to do. */
sealed interface IntentTarget {
    /** Nothing to navigate to (a plain launch, or the sign-in callback). */
    data object None : IntentTarget

    data class Load(val url: String) : IntentTarget

    /** A URL or start path arrived that the guard refused; the shopper is told, nothing loads. */
    data class Refused(val what: String) : IntentTarget
}

object ShellIntents {
    /**
     * [action], [dataString] and [startPath] come straight off the Intent. The sign-in callback
     * (the app's own scheme, [callbackScheme]) is handled by MainActivity.handleCallback, not here.
     */
    fun resolve(action: String?, dataString: String?, startPath: String?, callbackScheme: String): IntentTarget {
        if (action == "android.intent.action.VIEW" && dataString != null) {
            if (dataString.startsWith("$callbackScheme:")) return IntentTarget.None
            val allowed = AppLinkGuard.allowedTarget(dataString)
            return if (allowed != null) IntentTarget.Load(allowed) else IntentTarget.Refused("a link")
        }
        if (startPath != null) {
            val allowed = AppLinkGuard.targetForStartPath(startPath)
            return if (allowed != null) IntentTarget.Load(allowed) else IntentTarget.Refused("a start path")
        }
        return IntentTarget.None
    }
}
