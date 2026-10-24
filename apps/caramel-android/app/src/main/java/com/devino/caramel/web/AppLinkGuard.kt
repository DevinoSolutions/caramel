package com.devino.caramel.web

/**
 * Decides which URL may enter the shell's WebView (T-7817; mirrors snapvisor-pwa-android PR #15).
 *
 * MainActivity is exported, so any app on the device can send it a VIEW intent or a start-path
 * extra with any URL, and the page itself can navigate anywhere. This object is the only gate for
 * every way a URL reaches the WebView: shouldOverrideUrlLoading, incoming VIEW intents and the
 * start-path extra.
 *
 * The check is a plain string comparison on the exact origin, never a host lookup through
 * android.net.Uri or java.net.URI. Those parsers and Chromium do not always agree on where the
 * host is: "https://grabcaramel.com\@evil.com" reads as host grabcaramel.com to one parser and
 * evil.com to another. Comparing the raw string against "https://grabcaramel.com" followed by
 * '/', '?', '#' or nothing leaves nothing to interpret.
 *
 * Pure Kotlin on purpose, so AppLinkGuardTest covers it on the JVM without a device.
 */
object AppLinkGuard {
    /** The only origin the shell loads. Must equal [com.devino.caramel.core.AppConfig.WEBSITE_URL]. */
    const val APP_ORIGIN = "https://grabcaramel.com"

    /** Returns [url] when the shell may load it, otherwise null. */
    fun allowedTarget(url: String?): String? {
        if (url == null || !url.startsWith(APP_ORIGIN)) return null
        if (url.length > APP_ORIGIN.length) {
            // Without this, "https://grabcaramel.com.evil.com/" and "https://grabcaramel.com@evil.com/"
            // would pass the prefix test.
            val next = url[APP_ORIGIN.length]
            if (next != '/' && next != '?' && next != '#') return null
        }
        return if (url.any { isUnsafeChar(it) }) null else url
    }

    /** The URL for a deep path such as "/coupons", or null if it is not a path on the app origin. */
    fun targetForStartPath(startPath: String?): String? {
        if (startPath == null || !startPath.startsWith("/")) return null
        return allowedTarget(APP_ORIGIN + startPath)
    }

    /**
     * Characters the guard refuses anywhere in a URL: Chromium drops tabs and newlines and reads a
     * backslash as a slash, and Unicode spaces and format characters can hide inside an address.
     * Refusing them beats reasoning about what the WebView turns the URL into. A literal "%0a" (the
     * three-character text) is none of these and stays allowed.
     */
    internal fun isUnsafeChar(c: Char): Boolean = c.code <= 0x20 || c.code == 0x7f || c == '\\' || c.isWhitespace() ||
        when (c.category) {
            CharCategory.CONTROL,
            CharCategory.FORMAT,
            CharCategory.LINE_SEPARATOR,
            CharCategory.PARAGRAPH_SEPARATOR,
            CharCategory.SPACE_SEPARATOR,
            -> true
            else -> false
        }
}
