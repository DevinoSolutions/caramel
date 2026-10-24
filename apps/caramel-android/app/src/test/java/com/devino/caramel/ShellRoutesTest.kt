package com.devino.caramel

import com.devino.caramel.web.AuthAction
import com.devino.caramel.web.ExternalLink
import com.devino.caramel.web.ExternalLinkPolicy
import com.devino.caramel.web.IntentTarget
import com.devino.caramel.web.ShellIntents
import com.devino.caramel.web.ShellRoutes
import com.devino.caramel.web.ShellTab
import com.devino.caramel.web.ShellUserAgent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ShellRoutesTest {
    private val origin = "https://grabcaramel.com"

    @Test
    fun everyTabMapsToItsWebRoute() {
        assertEquals("$origin/coupons", ShellRoutes.urlFor(ShellTab.DEALS))
        assertEquals("$origin/coupons/stores", ShellRoutes.urlFor(ShellTab.SEARCH))
        assertEquals("$origin/profile#favorites", ShellRoutes.urlFor(ShellTab.SAVED))
        assertEquals("$origin/profile", ShellRoutes.urlFor(ShellTab.ACCOUNT))
        assertEquals(ShellRoutes.urlFor(ShellTab.DEALS), ShellRoutes.homeUrl())
    }

    @Test
    fun aUrlSelectsTheTabItBelongsTo() {
        assertEquals(ShellTab.DEALS, ShellRoutes.tabFor("$origin/coupons"))
        assertEquals(ShellTab.DEALS, ShellRoutes.tabFor("$origin/coupons/nike.com"))
        assertEquals(ShellTab.DEALS, ShellRoutes.tabFor("$origin/coupons?page=2"))
        assertEquals(ShellTab.SEARCH, ShellRoutes.tabFor("$origin/coupons/stores"))
        assertEquals(ShellTab.SEARCH, ShellRoutes.tabFor("$origin/coupons/stores?q=nike"))
        assertEquals(ShellTab.ACCOUNT, ShellRoutes.tabFor("$origin/profile"))
        assertEquals(ShellTab.ACCOUNT, ShellRoutes.tabFor("$origin/profile#privacy"))
        assertEquals(ShellTab.SAVED, ShellRoutes.tabFor("$origin/profile#favorites"))
    }

    @Test
    fun aUrlOutsideTheTabsOrTheOriginSelectsNothing() {
        assertNull(ShellRoutes.tabFor(null))
        assertNull(ShellRoutes.tabFor(origin))
        assertNull(ShellRoutes.tabFor("$origin/support"))
        assertNull(ShellRoutes.tabFor("$origin/profiles"))
        assertNull(ShellRoutes.tabFor("$origin/couponsx"))
        assertNull(ShellRoutes.tabFor("https://evil.com/coupons"))
    }

    @Test
    fun loginAndSignupAreTheSignInRoutes() {
        assertTrue(ShellRoutes.isSignInRoute("$origin/login"))
        assertTrue(ShellRoutes.isSignInRoute("$origin/login/"))
        assertTrue(ShellRoutes.isSignInRoute("$origin/login?next=%2Fprofile"))
        assertTrue(ShellRoutes.isSignInRoute("$origin/signup"))
        assertTrue(ShellRoutes.isSignInRoute("$origin/signup#x"))
        assertFalse(ShellRoutes.isSignInRoute("$origin/loginx"))
        assertFalse(ShellRoutes.isSignInRoute("$origin/login/reset"))
        assertFalse(ShellRoutes.isSignInRoute("$origin/forgot-password"))
        assertFalse(ShellRoutes.isSignInRoute("https://evil.com/login"))
        assertFalse(ShellRoutes.isSignInRoute(null))
    }

    @Test
    fun signedOutOpensTheNativeSignIn() {
        assertEquals(AuthAction.START_NATIVE_SIGN_IN, ShellRoutes.authAction("$origin/login", false, false))
        assertEquals(AuthAction.START_NATIVE_SIGN_IN, ShellRoutes.authAction("$origin/signup", false, true))
        assertEquals(AuthAction.NONE, ShellRoutes.authAction("$origin/coupons", false, false))
    }

    @Test
    fun aWebSignOutClearsTheNativeTokenOnlyOnceAWebSessionWasHandedOver() {
        assertEquals(AuthAction.SIGN_OUT_NATIVE_THEN_SIGN_IN, ShellRoutes.authAction("$origin/login", true, true))
        // T-7852 not wired: /login while signed in is a page without a session, not a sign-out. Never clear the token.
        assertEquals(AuthAction.WEB_SESSION_UNAVAILABLE, ShellRoutes.authAction("$origin/login", true, false))
        assertEquals(AuthAction.NONE, ShellRoutes.authAction("$origin/profile", true, true))
    }

    @Test
    fun userAgentSuffixNamesTheVersionAndPlatform() {
        assertEquals(" CaramelApp/1.6.0 (android)", ShellUserAgent.suffix("1.6.0", "Google"))
        assertEquals(" CaramelApp/1.6.0 (android)", ShellUserAgent.suffix("1.6.0", null))
        assertEquals(" CaramelApp/1.6.0 (fire)", ShellUserAgent.suffix("1.6.0", "Amazon"))
        assertEquals(" CaramelApp/1.6.0 (fire)", ShellUserAgent.suffix("1.6.0", "amazon"))
        assertEquals(" CaramelApp/1.6.0 (android)", ShellUserAgent.suffix("1.6.0", "Amazonas Phones"))
        assertEquals("Mozilla/5.0 (Linux; Android 14) CaramelApp/1.6.0 (android)", ShellUserAgent.append("Mozilla/5.0 (Linux; Android 14)", "1.6.0", "Google"))
    }

    @Test
    fun onlyWebMailAndPhoneLinksLeaveTheApp() {
        assertEquals(ExternalLink.BROWSER, ExternalLinkPolicy.classify("https://example.com/deal"))
        assertEquals(ExternalLink.BROWSER, ExternalLinkPolicy.classify("http://example.com/"))
        assertEquals(ExternalLink.BROWSER, ExternalLinkPolicy.classify("HTTPS://EXAMPLE.COM/"))
        assertEquals(ExternalLink.BROWSER, ExternalLinkPolicy.classify("https://grabcaramel.com.evil.com/")) // outside, never in the WebView
        assertEquals(ExternalLink.MAIL_OR_PHONE, ExternalLinkPolicy.classify("mailto:support@grabcaramel.com"))
        assertEquals(ExternalLink.MAIL_OR_PHONE, ExternalLinkPolicy.classify("tel:+15555550100"))
        val blocked = listOf(
            "",
            "javascript:alert(1)",
            "data:text/html,hi",
            "intent://x#Intent;scheme=https;end",
            "file:///data/data/com.devino.caramel/shared_prefs/x.xml",
            "content://x/y",
            "market://details?id=x",
            "https://grabcaramel.com\\@evil.com",
            "https://example.com/\nx",
            " https://example.com/",
        )
        for (url in blocked) assertEquals(url, ExternalLink.BLOCKED, ExternalLinkPolicy.classify(url))
    }

    @Test
    fun anIntentLoadsOnlyWhatTheGuardApproves() {
        val cb = "com.devino.caramel"
        val view = "android.intent.action.VIEW"
        assertEquals(IntentTarget.Load("$origin/coupons/nike.com"), ShellIntents.resolve(view, "$origin/coupons/nike.com", null, cb))
        assertEquals(IntentTarget.Load("$origin/profile"), ShellIntents.resolve(null, null, "/profile", cb))
        assertEquals(IntentTarget.None, ShellIntents.resolve("android.intent.action.MAIN", null, null, cb))
        // The sign-in callback belongs to MainActivity.handleCallback.
        assertEquals(IntentTarget.None, ShellIntents.resolve(view, "com.devino.caramel://auth/callback?code=x", null, cb))

        val evil = listOf(
            "https://evil.com/",
            "http://grabcaramel.com/",
            "https://grabcaramel.com.evil.com/",
            "https://grabcaramel.com\\@evil.com",
            "javascript:alert(1)",
            "file:///data/data/com.devino.caramel/",
        )
        for (data in evil) assertTrue(data, ShellIntents.resolve(view, data, null, cb) is IntentTarget.Refused)

        val badPaths = listOf("coupons", "@evil.com/", "/\\evil.com", "https://evil.com/")
        for (path in badPaths) assertTrue(path, ShellIntents.resolve(null, null, path, cb) is IntentTarget.Refused)
        // A VIEW intent's data wins over the extra: a bad link is refused even beside a good start path.
        assertTrue(ShellIntents.resolve(view, "https://evil.com/", "/coupons", cb) is IntentTarget.Refused)
    }
}
