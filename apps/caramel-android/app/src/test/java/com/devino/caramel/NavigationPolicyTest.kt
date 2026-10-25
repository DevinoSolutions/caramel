package com.devino.caramel

import com.devino.caramel.web.NavigationPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NavigationPolicyTest {
    @Test
    fun aPageCannotNavigateToTheRedeemRouteHoweverItIsSpelled() {
        val code = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"
        assertTrue(NavigationPolicy.isPageInitiatedRedeem("https://grabcaramel.com/api/app/web-session/redeem?code=$code"))
        assertTrue(NavigationPolicy.isPageInitiatedRedeem("https://grabcaramel.com/API/app/web-session/%72edeem?code=$code"))
        assertTrue(NavigationPolicy.isPageInitiatedRedeem("https://grabcaramel.com/api/app/web-session/redeem"))
        assertFalse(NavigationPolicy.isPageInitiatedRedeem("https://grabcaramel.com/profile"))
        assertFalse(NavigationPolicy.isPageInitiatedRedeem("https://grabcaramel.com/api/app/web-session/handoff"))
    }

    @Test
    fun aMainFrameRequestToAForeignOriginIsBlockedWhateverItsMethod() {
        // shouldInterceptRequest sees POSTs and 307/308 redirects that shouldOverrideUrlLoading never does.
        val foreign = listOf(
            "https://evil.com/collect",
            "http://grabcaramel.com/",
            "https://grabcaramel.com.evil.com/",
            "https://grabcaramel.com@evil.com/",
            "https://grabcaramel.com\\@evil.com/",
            "https://grabcaramel.com:8443/",
            "data:text/html,hi",
            "file:///data/data/com.devino.caramel/",
            "javascript:alert(1)",
        )
        for (url in foreign) assertTrue(url, NavigationPolicy.blockMainFrameRequest(isForMainFrame = true, url = url))
    }

    @Test
    fun anAllowedMainFrameRequestAndAnySubresourceAreNotBlocked() {
        assertFalse(NavigationPolicy.blockMainFrameRequest(true, "https://grabcaramel.com/coupons"))
        assertFalse(NavigationPolicy.blockMainFrameRequest(true, "https://grabcaramel.com"))
        // Subresources (scripts, images, fetch, iframes) are the page's own business, not navigations.
        assertFalse(NavigationPolicy.blockMainFrameRequest(false, "https://cdn.example.com/app.js"))
        assertFalse(NavigationPolicy.blockMainFrameRequest(false, "https://evil.com/pixel.gif"))
    }

    @Test
    fun anOffOriginLinkOpensOutsideOnlyAfterAGesture() {
        assertTrue(NavigationPolicy.mayOpenOutside(hasGesture = true, isRedirect = false, priorNavigationHadGesture = false))
        assertFalse(NavigationPolicy.mayOpenOutside(hasGesture = false, isRedirect = false, priorNavigationHadGesture = false))
        // A script or timer navigating away on its own, even right after a tap on the page earlier.
        assertFalse(NavigationPolicy.mayOpenOutside(hasGesture = false, isRedirect = false, priorNavigationHadGesture = true))
    }

    @Test
    fun aRedirectOpensOutsideOnlyWhenTheChainStartedWithAGesture() {
        assertTrue(NavigationPolicy.mayOpenOutside(hasGesture = false, isRedirect = true, priorNavigationHadGesture = true))
        assertFalse(NavigationPolicy.mayOpenOutside(hasGesture = false, isRedirect = true, priorNavigationHadGesture = false))
    }

    @Test
    fun theGestureStateFollowsTheNavigationChain() {
        assertTrue(NavigationPolicy.nextGestureState(hasGesture = true, isRedirect = false, priorNavigationHadGesture = false))
        assertFalse(NavigationPolicy.nextGestureState(hasGesture = false, isRedirect = false, priorNavigationHadGesture = true))
        // A redirect keeps whatever started the chain.
        assertTrue(NavigationPolicy.nextGestureState(hasGesture = false, isRedirect = true, priorNavigationHadGesture = true))
        assertFalse(NavigationPolicy.nextGestureState(hasGesture = true, isRedirect = true, priorNavigationHadGesture = false))
    }
}
