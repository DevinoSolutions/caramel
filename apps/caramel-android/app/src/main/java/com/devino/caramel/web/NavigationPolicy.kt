package com.devino.caramel.web

/** Pure decisions behind the WebView client's navigation hooks (JVM-testable). */
object NavigationPolicy {
    /**
     * Android calls `shouldOverrideUrlLoading` for GET navigations only: a main-frame form POST, or a
     * 307/308 redirect of one, reaches `shouldInterceptRequest` and nothing else. So that hook blocks
     * every main-frame request the [AppLinkGuard] would not load, whatever its method.
     */
    fun blockMainFrameRequest(isForMainFrame: Boolean, url: String): Boolean =
        isForMainFrame && AppLinkGuard.allowedTarget(url) == null

    /**
     * Whether an [AppLinkGuard]-approved main-frame navigation reads as the handoff redeem route. The shell's
     * own redeem load goes through `loadGuarded`, which `shouldOverrideUrlLoading` never sees, so anything
     * that arrives there (a link, a script, a redirect) is a redeem the shell did not issue and is refused.
     */
    fun isPageInitiatedRedeem(allowedUrl: String): Boolean = RedeemUrl.hasRedeemPath(allowedUrl)

    /**
     * Whether an off-origin navigation may be handed to the system (Custom Tab, dialer). A link the
     * shopper tapped has a gesture; a redirect is allowed only when the navigation that led to it had
     * one. A script or timer that navigates away on its own never opens another app.
     */
    fun mayOpenOutside(hasGesture: Boolean, isRedirect: Boolean, priorNavigationHadGesture: Boolean): Boolean =
        hasGesture || (isRedirect && priorNavigationHadGesture)

    /** The gesture state after a main-frame navigation: a redirect keeps the one that started the chain. */
    fun nextGestureState(hasGesture: Boolean, isRedirect: Boolean, priorNavigationHadGesture: Boolean): Boolean =
        if (isRedirect) priorNavigationHadGesture else hasGesture
}
