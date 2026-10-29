package com.devino.caramel

import com.devino.caramel.web.AuthAction
import com.devino.caramel.web.ExternalLink
import com.devino.caramel.web.ExternalLinkPolicy
import com.devino.caramel.web.IntentTarget
import com.devino.caramel.web.ShellIntents
import com.devino.caramel.web.ShellRoutes
import com.devino.caramel.web.ShellTab
import com.devino.caramel.web.ShellUserAgent
import com.devino.caramel.web.SignInLoopGuard
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
        assertEquals(AuthAction.START_NATIVE_SIGN_IN, ShellRoutes.authAction("$origin/login", false))
        assertEquals(AuthAction.START_NATIVE_SIGN_IN, ShellRoutes.authAction("$origin/signup", false))
        assertEquals(AuthAction.NONE, ShellRoutes.authAction("$origin/coupons", false))
    }

    @Test
    fun aLoginVisitWhileSignedInNeverSignsTheNativeSessionOut() {
        // With or without a web session: /login while signed in is a page to relink, never a reason to clear the token.
        assertEquals(AuthAction.LINK_WEB_SESSION, ShellRoutes.authAction("$origin/login", true))
        assertEquals(AuthAction.LINK_WEB_SESSION, ShellRoutes.authAction("$origin/signup", true))
        assertEquals(AuthAction.NONE, ShellRoutes.authAction("$origin/profile", true))
    }

    @Test
    fun aFailedRedeemRedirectIsAnUnlinkedLoginNotASignOut() {
        // The server answers a bad redeem with 303 -> /login?error=handoff_expired; the normalized intercept sees a sign-in route.
        assertEquals(AuthAction.LINK_WEB_SESSION, ShellRoutes.authAction("$origin/login?error=handoff_expired", true))
        assertEquals(AuthAction.LINK_WEB_SESSION, ShellRoutes.authAction("$origin/%4cOGIN?error=handoff_expired", true))
        assertEquals(AuthAction.START_NATIVE_SIGN_IN, ShellRoutes.authAction("$origin/login?error=handoff_expired", false))
    }

    @Test
    fun onlySavedAndAccountNeedTheWebSession() {
        assertEquals(listOf(ShellTab.SAVED, ShellTab.ACCOUNT), ShellTab.entries.filter { it.needsWebSession })
    }

    @Test
    fun userAgentSuffixNamesTheVersionPlatformAndBuild() {
        assertEquals(" CaramelApp/1.6.0 (android) CaramelBuild/42", ShellUserAgent.suffix("1.6.0", "Google", 42))
        assertEquals(" CaramelApp/1.6.0 (android) CaramelBuild/42", ShellUserAgent.suffix("1.6.0", null, 42))
        assertEquals(" CaramelApp/1.6.0 (fire) CaramelBuild/42", ShellUserAgent.suffix("1.6.0", "Amazon", 42))
        assertEquals(" CaramelApp/1.6.0 (fire) CaramelBuild/42", ShellUserAgent.suffix("1.6.0", "amazon", 42))
        assertEquals(" CaramelApp/1.6.0 (android) CaramelBuild/42", ShellUserAgent.suffix("1.6.0", "Amazonas Phones", 42))
        assertEquals("Mozilla/5.0 (Linux; Android 14) CaramelApp/1.6.0 (android) CaramelBuild/42", ShellUserAgent.append("Mozilla/5.0 (Linux; Android 14)", "1.6.0", "Google", 42))
    }

    @Test
    fun theBuildIsASeparateTokenAfterTheCaramelAppOne() {
        // The web matcher needs whitespace (or the end) right after "(<platform>)"; the build token's leading space gives it.
        val userAgent = ShellUserAgent.append("Mozilla/5.0", "1.6.0", "Google", 7)
        val appMatcher = Regex("""(?:^|\s)CaramelApp/(\d+\.\d+\.\d+) \((ios|macos|android|fire)\)(?:\s|$)""")
        val buildMatcher = Regex("""(?:^|\s)CaramelBuild/(\d+)(?:\s|$)""")
        assertEquals("android", appMatcher.find(userAgent)?.groupValues?.get(2))
        assertEquals("7", buildMatcher.find(userAgent)?.groupValues?.get(1))
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

    @Test
    fun theSignInRoutesAreCaughtWhateverTheirSpelling() {
        val spellings = listOf(
            "/login", "/login/", "//login", "///login", "/%6cogin", "/%6Cogin", "/lo%67in", "/LOGIN", "/Login/",
            "/./login", "/x/../login", "/x/%2e%2e/login", "/%2e/login", "/coupons/..%2flogin", "/signup", "//SIGNUP/", "/sign%75p",
            "/login?next=%2Fprofile", "/login#x",
        )
        for (path in spellings) assertTrue(path, ShellRoutes.isSignInRoute("$origin$path"))
        for (path in spellings) {
            assertEquals(path, AuthAction.START_NATIVE_SIGN_IN, ShellRoutes.authAction("$origin$path", false))
        }
    }

    @Test
    fun lookAlikePathsAreNotSignInRoutes() {
        val others = listOf(
            "/", "/loginx", "/login/reset", "/log%69n%2fx", "/%256cogin", "/coupons/login", "/signup-now", "/forgot-password", "/coupons?next=/login",
        )
        for (path in others) assertFalse(path, ShellRoutes.isSignInRoute("$origin$path"))
    }

    @Test
    fun pathsAreNormalizedTheWayABrowserReadsThem() {
        assertEquals("/", ShellRoutes.normalizedPath(origin))
        assertEquals("/", ShellRoutes.normalizedPath("$origin/?x=1"))
        assertEquals("/coupons/stores", ShellRoutes.normalizedPath("$origin//coupons///stores/"))
        assertEquals("/login", ShellRoutes.normalizedPath("$origin/a/b/../../%4cogin"))
        assertEquals("/", ShellRoutes.normalizedPath("$origin/../../.."))
        assertEquals("/%6cogin", ShellRoutes.normalizedPath("$origin/%256cogin")) // decoded once, not twice
        assertEquals("/a%zzb", ShellRoutes.normalizedPath("$origin/A%zzB")) // a malformed escape stays literal
        assertEquals("/café", ShellRoutes.normalizedPath("$origin/caf%C3%A9"))
        assertNull(ShellRoutes.normalizedPath(null))
    }

    @Test
    fun anIntentMayOnlyLandOnTheAllowedPaths() {
        val allowed = listOf(
            "", "/", "/coupons", "/coupons/stores", "/coupons/nike.com", "/profile", "/profile#favorites", "/profile/x",
            "/privacy", "/support", "/support?x=1", "//coupons", "/%63oupons", "/COUPONS",
        )
        for (path in allowed) assertTrue(path, ShellRoutes.isIntentPathAllowed("$origin$path"))
        val denied = listOf(
            "/login", "/signup", "//login", "/%6cogin", "/api/extension/oauth", "/api/account/delete", "/verify", "/reset-password",
            "/welcome", "/couponsx", "/profiles", "/privacy-x", "/coupons/../login", "/coupons%2f..%2flogin", "/support/../api",
        )
        for (path in denied) assertFalse(path, ShellRoutes.isIntentPathAllowed("$origin$path"))
        assertFalse(ShellRoutes.isIntentPathAllowed("https://evil.com/coupons"))
        assertFalse(ShellRoutes.isIntentPathAllowed(null))
    }

    @Test
    fun anIntentOnAnUnlistedPathFallsBackToHome() {
        val cb = "com.devino.caramel"
        val view = "android.intent.action.VIEW"
        val home = ShellRoutes.homeUrl()
        assertEquals(IntentTarget.Load(home), ShellIntents.resolve(view, "$origin/login", null, cb))
        assertEquals(IntentTarget.Load(home), ShellIntents.resolve(view, "$origin/%6cogin", null, cb))
        assertEquals(IntentTarget.Load(home), ShellIntents.resolve(view, "$origin/api/account/delete", null, cb))
        assertEquals(IntentTarget.Load(home), ShellIntents.resolve(null, null, "/signup", cb))
        assertEquals(IntentTarget.Load(home), ShellIntents.resolve(null, null, "/welcome?x=1", cb))
        assertEquals(IntentTarget.Load("$origin/privacy"), ShellIntents.resolve(null, null, "/privacy", cb))
        assertEquals(IntentTarget.Load("$origin/support"), ShellIntents.resolve(view, "$origin/support", null, cb))
        // A URL the guard refuses is still refused, not turned into a home load.
        assertTrue(ShellIntents.resolve(view, "https://evil.com/coupons", null, cb) is IntentTarget.Refused)
    }
}

/** SignInLoopGuard: the Android sign-in loop cap (T-10055), twin of the iOS SignInLoopCoordinator cap. */
class SignInLoopGuardTest {
    private val start = 1_000_000L
    private val second = 1_000L

    private fun parkedGuard(): SignInLoopGuard {
        val guard = SignInLoopGuard()
        repeat(SignInLoopGuard.MAX_AUTOMATIC_REQUESTS) { lap ->
            assertEquals(SignInLoopGuard.Admission.ADMITTED, guard.automaticSignInRequest(start + lap * second))
        }
        assertEquals(SignInLoopGuard.Admission.PARKED_NOW, guard.automaticSignInRequest(start + 4 * second))
        return guard
    }

    @Test
    fun theFifthAutomaticRequestInAMinuteParksAndIsReportedOnce() {
        val guard = parkedGuard()
        assertTrue(guard.isParked)
        repeat(20) { lap ->
            assertEquals(SignInLoopGuard.Admission.PARKED, guard.automaticSignInRequest(start + (5 + lap) * second))
        }
    }

    @Test
    fun slowRequestsNeverPark() {
        val guard = SignInLoopGuard()
        repeat(20) { lap ->
            assertEquals(SignInLoopGuard.Admission.ADMITTED, guard.automaticSignInRequest(start + lap * 20 * second))
        }
        assertFalse(guard.isParked)
    }

    @Test
    fun theWindowSlides() {
        val guard = SignInLoopGuard()
        repeat(SignInLoopGuard.MAX_AUTOMATIC_REQUESTS) { lap -> guard.automaticSignInRequest(start + lap * second) }
        assertEquals(SignInLoopGuard.Admission.ADMITTED, guard.automaticSignInRequest(start + SignInLoopGuard.WINDOW_MILLIS + 3_500))
    }

    @Test
    fun theLatchSurvivesTimeAndAWebViewReset() {
        // CaramelApp keeps one guard across WebView generations, so a reset is the same guard seeing more requests.
        val guard = parkedGuard()
        for (later in listOf(SignInLoopGuard.WINDOW_MILLIS + 5 * second, 3_600_000L, 86_400_000L)) {
            assertEquals(SignInLoopGuard.Admission.PARKED, guard.automaticSignInRequest(start + later))
            assertTrue(guard.isParked)
            assertFalse(guard.admitsLoad(SignInLoopGuard.LoadOrigin.AUTOMATIC))
        }
    }

    @Test
    fun aParkedShellRefusesAutomaticLoadsButNotATap() {
        // The home load after a WebView rebuild or a session change, and a late handoff's redeem URL, are AUTOMATIC.
        val guard = SignInLoopGuard()
        assertTrue(guard.admitsLoad(SignInLoopGuard.LoadOrigin.AUTOMATIC))
        val parked = parkedGuard()
        assertFalse(parked.admitsLoad(SignInLoopGuard.LoadOrigin.AUTOMATIC))
        assertTrue(parked.admitsLoad(SignInLoopGuard.LoadOrigin.SHOPPER_TAP))
        assertTrue("a tap does not unpark by loading; userTapped does", parked.isParked)
    }

    @Test
    fun aTapUnparksAndStartsTheCountOver() {
        val guard = parkedGuard()
        guard.userTapped()
        assertFalse(guard.isParked)
        assertTrue(guard.admitsLoad(SignInLoopGuard.LoadOrigin.AUTOMATIC))
        repeat(SignInLoopGuard.MAX_AUTOMATIC_REQUESTS) { lap ->
            assertEquals(SignInLoopGuard.Admission.ADMITTED, guard.automaticSignInRequest(start + (6 + lap) * second))
        }
        assertEquals(SignInLoopGuard.Admission.PARKED_NOW, guard.automaticSignInRequest(start + 10 * second))
    }
}
