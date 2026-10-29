package com.devino.caramel.web

enum class ExternalLink {
    /** Open in a Custom Tab. */
    BROWSER,

    /** Open with ACTION_VIEW (the mail or dialer app). */
    MAIL_OR_PHONE,

    /** Not opened anywhere; the shopper is told. */
    BLOCKED,
}

/**
 * What to do with a URL the [AppLinkGuard] refused to load into the WebView. It is handed to the
 * system, never to the WebView, and only when it is a plain web, mail or phone link: `intent:`,
 * `javascript:`, `data:`, `file:` and friends are blocked, and so is any address containing a
 * character [AppLinkGuard.isUnsafeChar] refuses (a parser-differential URL is not opened in a
 * browser either).
 */
object ExternalLinkPolicy {
    fun classify(url: String): ExternalLink {
        if (url.any { AppLinkGuard.isUnsafeChar(it) }) return ExternalLink.BLOCKED
        val lower = url.lowercase()
        return when {
            lower.startsWith("https://") || lower.startsWith("http://") -> ExternalLink.BROWSER
            lower.startsWith("mailto:") || lower.startsWith("tel:") -> ExternalLink.MAIL_OR_PHONE
            else -> ExternalLink.BLOCKED
        }
    }
}
