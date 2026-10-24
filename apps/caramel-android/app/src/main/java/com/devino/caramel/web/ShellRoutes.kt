package com.devino.caramel.web

import java.io.ByteArrayOutputStream

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
        val path = normalizedPath(allowed) ?: return null
        val fragment = allowed.substringAfter('#', "")
        return when {
            isUnder(path, "/profile") -> if (fragment == "favorites") ShellTab.SAVED else ShellTab.ACCOUNT
            isUnder(path, "/coupons/stores") -> ShellTab.SEARCH
            isUnder(path, "/coupons") -> ShellTab.DEALS
            else -> null
        }
    }

    fun isSignInRoute(url: String?): Boolean {
        val path = normalizedPath(AppLinkGuard.allowedTarget(url)) ?: return false
        return path == "/login" || path == "/signup"
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

    /**
     * Whether an intent (VIEW data or the start-path extra) may land on [url]: only the home page,
     * the coupon pages, the profile, the privacy policy and support. Anything else on the origin
     * (the login and signup pages, auth callbacks, API routes) is not a place another app may send
     * the shopper, so the shell falls back to home.
     */
    fun isIntentPathAllowed(url: String?): Boolean {
        val path = normalizedPath(AppLinkGuard.allowedTarget(url)) ?: return false
        return path == "/" || isUnder(path, "/coupons") || isUnder(path, "/profile") ||
            isUnder(path, "/privacy") || isUnder(path, "/support")
    }

    /**
     * The path of an [AppLinkGuard]-approved URL the way a browser and the server will read it:
     * percent-escapes decoded once, empty and "." segments dropped, ".." resolved, one leading
     * slash, lowercased. So "/%6cogin", "//login", "/./login" and "/a/../LOGIN" all become
     * "/login". Null when [allowed] is null.
     */
    fun normalizedPath(allowed: String?): String? {
        if (allowed == null) return null
        val rawPath = allowed.removePrefix(AppLinkGuard.APP_ORIGIN).substringBefore('#').substringBefore('?')
        val segments = ArrayList<String>()
        for (segment in percentDecodeOnce(rawPath).split('/')) {
            when (segment) {
                "", "." -> Unit
                ".." -> if (segments.isNotEmpty()) segments.removeAt(segments.size - 1)
                else -> segments.add(segment)
            }
        }
        return "/" + segments.joinToString("/").lowercase()
    }

    private fun isUnder(path: String, prefix: String): Boolean = path == prefix || path.startsWith("$prefix/")

    /** Decodes %XX escapes once (UTF-8); a malformed escape stays literal. No "+" handling: this is a path. */
    internal fun percentDecodeOnce(text: String): String {
        val out = ByteArrayOutputStream()
        var i = 0
        while (i < text.length) {
            val c = text[i]
            if (c == '%' && i + 2 < text.length && Character.digit(text[i + 1], 16) >= 0 && Character.digit(text[i + 2], 16) >= 0) {
                out.write(Character.digit(text[i + 1], 16) * 16 + Character.digit(text[i + 2], 16))
                i += 3
            } else {
                val codePoint = text.codePointAt(i)
                out.write(String(Character.toChars(codePoint)).toByteArray(Charsets.UTF_8))
                i += Character.charCount(codePoint)
            }
        }
        return String(out.toByteArray(), Charsets.UTF_8)
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
     * A URL the guard approves but whose path is not on the allowlist loads the home page instead.
     */
    fun resolve(action: String?, dataString: String?, startPath: String?, callbackScheme: String): IntentTarget {
        if (action == "android.intent.action.VIEW" && dataString != null) {
            if (dataString.startsWith("$callbackScheme:")) return IntentTarget.None
            return landing(AppLinkGuard.allowedTarget(dataString), "a link")
        }
        if (startPath != null) return landing(AppLinkGuard.targetForStartPath(startPath), "a start path")
        return IntentTarget.None
    }

    private fun landing(allowed: String?, what: String): IntentTarget = when {
        allowed == null -> IntentTarget.Refused(what)
        ShellRoutes.isIntentPathAllowed(allowed) -> IntentTarget.Load(allowed)
        else -> IntentTarget.Load(ShellRoutes.homeUrl())
    }
}
