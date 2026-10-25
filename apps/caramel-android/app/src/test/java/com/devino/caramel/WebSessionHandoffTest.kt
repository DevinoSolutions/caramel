package com.devino.caramel

import com.devino.caramel.core.CaramelApi
import com.devino.caramel.core.HttpRequest
import com.devino.caramel.core.HttpResponse
import com.devino.caramel.core.HttpTransport
import com.devino.caramel.core.SessionStore
import com.devino.caramel.web.HandoffNext
import com.devino.caramel.web.HandoffStep
import com.devino.caramel.web.LoginBounceOutcome
import com.devino.caramel.web.RedeemRequest
import com.devino.caramel.web.RedeemUrl
import com.devino.caramel.web.ShellTab
import com.devino.caramel.web.WebSessionCookie
import com.devino.caramel.web.WebSessionHandoff
import com.devino.caramel.web.WebSessionHandoffClient
import com.devino.caramel.web.WebSessionLifecycle
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

private const val ORIGIN = "https://grabcaramel.com"
private const val CODE = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ" // 43 characters, like the server's
private const val REDEEM = "$ORIGIN/api/app/web-session/redeem?code=$CODE"
private const val BEARER = "bearer-secret-1"

private fun handoffBody(url: String = REDEEM) = """{"url":"$url","expiresInSeconds":60}"""

class HandoffNextTest {
    @Test
    fun anAllowedTargetIsSentAsIs() {
        assertEquals("/", HandoffNext.forPath("/"))
        assertEquals("/coupons", HandoffNext.forPath("/coupons"))
        assertEquals("/coupons/stores", HandoffNext.forPath("/coupons/stores"))
        assertEquals("/profile", HandoffNext.forPath("/profile"))
        assertEquals("/profile#favorites", HandoffNext.forPath("/profile#favorites"))
        assertEquals("/welcome?src=app", HandoffNext.forPath("/welcome?src=app"))
    }

    @Test
    fun aTargetOutsideTheServerAllowlistBecomesRoot() {
        val rejected = listOf(
            null,
            "",
            "profile",
            "/login",
            "/signup",
            "/privacy",
            "/support",
            "/api/account/delete",
            "/couponsfoo",
            "/profiles",
            "//evil.com",
            "https://evil.com/profile",
            "/profile/../login",
            "/./profile",
            "/%70rofile",
            "/profile%0d%0ax",
            "/profile\\x",
            "/profile x",
            "/profile\nx",
        )
        for (path in rejected) assertEquals("path $path", "/", HandoffNext.forPath(path))
        assertEquals("/", HandoffNext.forPath("/profile/" + "a".repeat(600)))
    }

    @Test
    fun everyTabWithAStartPathMapsToItself() {
        for (tab in ShellTab.entries) assertEquals(tab.name, tab.startPath, HandoffNext.forPath(tab.startPath))
    }

    @Test
    fun landingsAreTheHomePageAndTheAllowedPrefixes() {
        assertTrue(HandoffNext.isAllowlistedLanding("/"))
        assertTrue(HandoffNext.isAllowlistedLanding("/coupons"))
        assertTrue(HandoffNext.isAllowlistedLanding("/profile"))
        assertTrue(HandoffNext.isAllowlistedLanding("/welcome/x"))
        assertFalse(HandoffNext.isAllowlistedLanding("/login"))
        assertFalse(HandoffNext.isAllowlistedLanding("/signup"))
        assertFalse(HandoffNext.isAllowlistedLanding("/api/app/web-session/redeem"))
        assertFalse(HandoffNext.isAllowlistedLanding("/couponsfoo"))
    }
}

class RedeemUrlTest {
    @Test
    fun onlyTheExactRedeemPathWithACodeMatches() {
        assertTrue(RedeemUrl.matches(REDEEM))
        assertFalse(RedeemUrl.matches(null))
        assertFalse(RedeemUrl.matches("$ORIGIN/api/app/web-session/redeem"))
        assertFalse(RedeemUrl.matches("$ORIGIN/api/app/web-session/redeem?code="))
        assertFalse(RedeemUrl.matches("$ORIGIN/api/app/web-session/redeem?x=1&code=$CODE"))
        assertFalse(RedeemUrl.matches("$ORIGIN/api/app/web-session/redeem/?code=$CODE"))
        assertFalse(RedeemUrl.matches("$ORIGIN/api/app/web-session/handoff?code=$CODE"))
        assertFalse(RedeemUrl.matches("$ORIGIN/api/app/web-session/REDEEM?code=$CODE"))
        assertFalse(RedeemUrl.matches("$ORIGIN/api/app/web-session/redeem?code=$CODE#x"))
        assertFalse(RedeemUrl.matches("$ORIGIN/coupons"))
        assertFalse(RedeemUrl.matches("https://evil.com/api/app/web-session/redeem?code=$CODE"))
        assertFalse(RedeemUrl.matches("https://grabcaramel.com.evil.com/api/app/web-session/redeem?code=$CODE"))
        assertFalse(RedeemUrl.matches("http://grabcaramel.com/api/app/web-session/redeem?code=$CODE"))
    }
}

class WebSessionHandoffClientTest {
    private fun client(handler: (HttpRequest) -> HttpResponse): Pair<WebSessionHandoffClient, FakeTransport> {
        val (api, transport) = testApi(handler)
        return WebSessionHandoffClient(api) to transport
    }

    @Test
    fun successPostsTheBearerAndTheMappedNextAndReturnsTheRedeemUrl() = runBlocking {
        val (client, transport) = client { ok(handoffBody()) }

        val result = client.requestRedeemUrl(BEARER, "/profile#favorites")

        assertEquals(RedeemRequest.Url(REDEEM), result)
        val request = transport.requests.single()
        assertEquals("POST", request.method)
        assertEquals("https://example.test/api/app/web-session/handoff", request.url)
        assertEquals("Bearer $BEARER", request.headers["Authorization"])
        assertEquals("application/json", request.headers["Content-Type"])
        assertEquals("""{"next":"/profile#favorites"}""", request.body)
        assertEquals(10_000, request.timeoutMs)
    }

    @Test
    fun aTargetTheServerRejectsIsSentAsRoot() = runBlocking {
        val (client, transport) = client { ok(handoffBody()) }
        client.requestRedeemUrl(BEARER, "/login")
        assertEquals("""{"next":"/"}""", transport.requests.single().body)
    }

    @Test
    fun a401MeansTheNativeSessionIsDead() = runBlocking {
        val (client, _) = client { HttpResponse(401, """{"error":"unauthorized"}""") }
        assertEquals(RedeemRequest.SessionExpired, client.requestRedeemUrl(BEARER, "/profile"))
    }

    @Test
    fun aServerErrorFailsWithoutLeakingTheBearerOrTheBody() = runBlocking {
        val (client, _) = client { HttpResponse(503, """{"error":"down $CODE"}""") }

        val result = client.requestRedeemUrl(BEARER, "/profile") as RedeemRequest.Failed

        assertTrue(result.message, "HTTP 503" in result.message)
        assertTrue(result.message, "req-1" in result.message)
        assertFalse(BEARER in result.message)
        assertFalse(CODE in result.message)
    }

    @Test
    fun aRateLimitIsAFailureNotASignOut() = runBlocking {
        val (client, _) = client { HttpResponse(429, """{"error":"slow down"}""") }
        assertTrue(client.requestRedeemUrl(BEARER, "/profile") is RedeemRequest.Failed)
    }

    @Test
    fun aTimeoutOrNoConnectionFails() = runBlocking {
        val (api, _) = testApi { throw IOException("timed out") }
        val result = WebSessionHandoffClient(api).requestRedeemUrl(BEARER, "/profile") as RedeemRequest.Failed
        assertTrue(result.message, "no connection or timed out" in result.message)
        assertFalse(BEARER in result.message)
    }

    @Test
    fun aMalformedAnswerFailsWithoutEchoingIt() = runBlocking {
        val (client, _) = client { ok("""{"unexpected":"$CODE"}""") }
        val result = client.requestRedeemUrl(BEARER, "/profile") as RedeemRequest.Failed
        assertTrue(result.message, "unexpected response" in result.message)
        assertFalse(CODE in result.message)
    }

    @Test
    fun aRedeemUrlOnAnotherOriginIsRefused() = runBlocking {
        for (url in listOf(
            "https://evil.com/api/app/web-session/redeem?code=$CODE",
            "https://grabcaramel.com.evil.com/api/app/web-session/redeem?code=$CODE",
            "https://grabcaramel.com\\@evil.com/api/app/web-session/redeem?code=$CODE",
        )) {
            val (client, _) = client { ok(handoffBody(url)) }
            val result = client.requestRedeemUrl(BEARER, "/profile")
            assertTrue(url, result is RedeemRequest.Failed)
            assertFalse(url, CODE in (result as RedeemRequest.Failed).message)
        }
    }

    @Test
    fun aRedeemUrlWithTheWrongPathIsRefused() = runBlocking {
        for (url in listOf(
            "$ORIGIN/profile",
            "$ORIGIN/api/extension/session?code=$CODE",
            "$ORIGIN/api/app/web-session/redeem-old?code=$CODE",
            "$ORIGIN/login?error=handoff_expired",
        )) {
            val (client, _) = client { ok(handoffBody(url)) }
            assertTrue(url, client.requestRedeemUrl(BEARER, "/profile") is RedeemRequest.Failed)
        }
    }
}

class RedeemUrlStrictnessTest {
    @Test
    fun theCodeIsExactlyOneParamOf43Base64urlCharacters() {
        assertTrue(RedeemUrl.matches("$ORIGIN/api/app/web-session/redeem?code=AZaz09-_AZaz09-_AZaz09-_AZaz09-_AZaz09-_AZa"))
        assertFalse("42 characters", RedeemUrl.matches("$ORIGIN/api/app/web-session/redeem?code=${CODE.dropLast(1)}"))
        assertFalse("44 characters", RedeemUrl.matches("$ORIGIN/api/app/web-session/redeem?code=${CODE}A"))
        assertFalse("base64 plus", RedeemUrl.matches("$ORIGIN/api/app/web-session/redeem?code=${CODE.dropLast(1)}+"))
        assertFalse("percent escape", RedeemUrl.matches("$ORIGIN/api/app/web-session/redeem?code=${CODE.dropLast(3)}%41%41"))
        assertFalse("second param after", RedeemUrl.matches("$ORIGIN/api/app/web-session/redeem?code=$CODE&next=/login"))
        assertFalse("second code", RedeemUrl.matches("$ORIGIN/api/app/web-session/redeem?code=$CODE&code=$CODE"))
        assertFalse("param before", RedeemUrl.matches("$ORIGIN/api/app/web-session/redeem?next=/login&code=$CODE"))
    }

    @Test
    fun anyRedeemSpellingReadsAsTheRedeemPath() {
        assertTrue(RedeemUrl.hasRedeemPath(REDEEM))
        assertTrue(RedeemUrl.hasRedeemPath("$ORIGIN/API/app/web-session/redeem?code=x"))
        assertTrue(RedeemUrl.hasRedeemPath("$ORIGIN/api/app/web-session/%72edeem?code=x"))
        assertTrue(RedeemUrl.hasRedeemPath("$ORIGIN/api/app/./web-session//redeem"))
        assertFalse(RedeemUrl.hasRedeemPath("$ORIGIN/api/app/web-session/handoff"))
        assertFalse(RedeemUrl.hasRedeemPath("$ORIGIN/coupons"))
        assertFalse(RedeemUrl.hasRedeemPath("https://evil.com/api/app/web-session/redeem"))
        assertFalse(RedeemUrl.hasRedeemPath(null))
    }
}

class WebSessionCookieTest {
    @Test
    fun onlyTheNamedNonEmptyCookieCounts() {
        assertTrue(WebSessionCookie.isPresent("a=1; __Secure-better-auth.session_token=abc.def; b=2"))
        assertTrue(WebSessionCookie.isPresent("__Secure-better-auth.session_token=abc"))
        assertFalse(WebSessionCookie.isPresent(null))
        assertFalse(WebSessionCookie.isPresent(""))
        assertFalse(WebSessionCookie.isPresent("__Secure-better-auth.session_token="))
        assertFalse("the non-secure name is not what the https site sets", WebSessionCookie.isPresent("better-auth.session_token=abc"))
        assertFalse(WebSessionCookie.isPresent("x__Secure-better-auth.session_token=abc"))
        assertFalse(WebSessionCookie.isPresent("a=__Secure-better-auth.session_token=abc"))
    }
}

class WebSessionLifecycleTest {
    @Test
    fun theWebViewIsWipedWhenTheNativeTokenGoesAway() {
        assertTrue("A to null: sign-out, deletion, any 401", WebSessionLifecycle.shouldWipeWebSession("token-a", null))
    }

    @Test
    fun theWebViewIsWipedWhenAnotherAccountReplacesTheToken() {
        assertTrue("A to B never passes through null", WebSessionLifecycle.shouldWipeWebSession("token-a", "token-b"))
    }

    @Test
    fun noWipeAtLaunchOrWhileTheTokenIsUnchanged() {
        assertFalse("null to A: launch load or a first sign-in", WebSessionLifecycle.shouldWipeWebSession(null, "token-a"))
        assertFalse("A to A", WebSessionLifecycle.shouldWipeWebSession("token-a", "token-a"))
        assertFalse("null to null", WebSessionLifecycle.shouldWipeWebSession(null, null))
    }

    @Test
    fun onlyAReplacementTokenIsRelinkedAfterTheWipe() {
        assertTrue(WebSessionLifecycle.shouldRelinkAfterWipe("token-b"))
        assertFalse(WebSessionLifecycle.shouldRelinkAfterWipe(null))
    }

    @Test
    fun everyPathThatNullsTheTokenFlipsIsSignedIn() = runBlocking {
        // validate 401, deleteAccount 401 and the handoff 401 all end in SessionStore.endExpiredSession (the wipe keys off isSignedIn).
        val (api, _) = testApi { request ->
            if (request.url.endsWith("/api/extension/me")) HttpResponse(401, """{"error":"expired"}""") else HttpResponse(401, "{}")
        }
        for (trigger in listOf<suspend (SessionStore) -> Unit>(
            { it.validate() },
            { it.deleteAccount() },
            { WebSessionHandoff(WebSessionHandoffClient(api), it) { true }.startFresh("/profile") },
        )) {
            val store = SessionStore(api, MemoryTokenStore(BEARER))
            store.load()
            assertTrue(store.state.value.isSignedIn)
            trigger(store)
            assertFalse(store.state.value.isSignedIn)
        }
    }
}

class WebSessionHandoffTest {
    private class Harness(
        token: String? = BEARER,
        var cookiePresent: Boolean = true,
        handler: suspend Harness.(HttpRequest) -> HttpResponse = { ok(handoffBody()) },
    ) {
        val requests = mutableListOf<HttpRequest>()
        val tokens = MemoryTokenStore(token)
        val session: SessionStore
        val webSession: WebSessionHandoff

        init {
            val transport = object : HttpTransport {
                override suspend fun execute(request: HttpRequest): HttpResponse {
                    requests += request
                    return handler(this@Harness, request)
                }
            }
            val api = CaramelApi("https://example.test", transport) { "req-${requests.size + 1}" }
            session = SessionStore(api, tokens)
            webSession = WebSessionHandoff(WebSessionHandoffClient(api), session) { cookiePresent }
        }
    }

    private fun Harness.signedIn(): Harness = also { runBlocking { it.session.load() } }

    // region active state: a landing alone is not proof

    @Test
    fun webSessionIsActiveOnlyAfterTheIssuedRedeemLandsOnAnAllowlistedPathWithTheCookie() = runBlocking {
        val h = Harness().signedIn()
        assertFalse(h.webSession.active)

        assertEquals(HandoffStep.Load(REDEEM), h.webSession.startFresh("/profile"))
        assertFalse("a redeem URL handed out is not a landing", h.webSession.active)

        assertTrue(h.webSession.admitLoad(REDEEM))
        h.webSession.onPageVisited(REDEEM) // the redeem itself: its 303 is still coming
        assertFalse(h.webSession.active)

        h.webSession.onPageVisited("$ORIGIN/profile")
        assertTrue(h.webSession.active)
    }

    @Test
    fun aMainFrameErrorEndsTheRedeemSoALaterVisitNeverActivates() = runBlocking {
        val h = Harness().signedIn()
        h.webSession.startFresh("/profile")
        h.webSession.admitLoad(REDEEM)

        h.webSession.onLoadFailed()
        h.webSession.onPageVisited("$ORIGIN/profile")

        assertFalse(h.webSession.active)
    }

    @Test
    fun aNonAllowlistedLandingEndsTheRedeemSoALaterVisitNeverActivates() = runBlocking {
        val h = Harness().signedIn()
        h.webSession.startFresh("/profile")
        h.webSession.admitLoad(REDEEM)

        h.webSession.onPageVisited("$ORIGIN/login?error=handoff_expired")
        h.webSession.onPageVisited("$ORIGIN/profile")

        assertFalse(h.webSession.active)
    }

    @Test
    fun leavingTheSiteEndsTheRedeem() = runBlocking {
        val h = Harness().signedIn()
        h.webSession.startFresh("/profile")
        h.webSession.admitLoad(REDEEM)

        h.webSession.onPageVisited("https://evil.com/profile")
        h.webSession.onPageVisited("$ORIGIN/profile")

        assertFalse(h.webSession.active)
    }

    @Test
    fun aLandingWithoutTheSessionCookieDoesNotActivateAndShowsAFailure() = runBlocking {
        val h = Harness(cookiePresent = false).signedIn()
        h.webSession.startFresh("/profile")
        h.webSession.admitLoad(REDEEM)

        h.webSession.onPageVisited("$ORIGIN/profile")

        assertFalse(h.webSession.active)
        assertNotNull(h.webSession.failure.value)
    }

    @Test
    fun aLandingThatDidNotFollowARedeemDoesNotActivate() = runBlocking {
        val h = Harness().signedIn()
        h.webSession.onPageVisited("$ORIGIN/coupons") // no handoff yet
        assertFalse(h.webSession.active)

        h.webSession.startFresh("/profile")
        assertTrue(h.webSession.admitLoad("$ORIGIN/coupons")) // the shopper loaded something else before the redeem
        h.webSession.onPageVisited("$ORIGIN/coupons")
        assertFalse(h.webSession.active)
    }

    @Test
    fun resetClearsTheWebSession() = runBlocking {
        val h = Harness().signedIn()
        h.webSession.startFresh("/profile")
        h.webSession.admitLoad(REDEEM)
        h.webSession.onPageVisited("$ORIGIN/profile")
        assertTrue(h.webSession.active)

        h.webSession.reset() // sign-out
        assertFalse(h.webSession.active)
        h.webSession.onPageVisited("$ORIGIN/profile") // nothing in flight: stays inactive
        assertFalse(h.webSession.active)
    }

    @Test
    fun aNewHandoffStartsFromNoWebSession() = runBlocking {
        val h = Harness().signedIn()
        h.webSession.startFresh("/profile")
        h.webSession.admitLoad(REDEEM)
        h.webSession.onPageVisited("$ORIGIN/profile")
        assertTrue(h.webSession.active)

        h.webSession.startFresh("/profile") // a different person signed in, say
        assertFalse(h.webSession.active)
    }

    // endregion

    // region /login bounces: one retry, never a native sign-out

    @Test
    fun anExpiredRedeemGetsExactlyOneFreshHandoffThenNativeSignIn() = runBlocking {
        val h = Harness().signedIn()
        assertTrue(h.webSession.startFresh("/profile") is HandoffStep.Load)
        assertEquals(1, h.requests.size)

        // The redeem answered 303 -> /login?error=handoff_expired: the first bounce retries once.
        assertEquals(LoginBounceOutcome.Retried(HandoffStep.Load(REDEEM)), h.webSession.retryAfterLoginBounce("/profile"))
        assertEquals(2, h.requests.size)

        // It bounced again: no third handoff, native sign-in, and it stays that way.
        assertEquals(LoginBounceOutcome.NativeSignIn, h.webSession.retryAfterLoginBounce("/profile"))
        assertEquals(LoginBounceOutcome.NativeSignIn, h.webSession.retryAfterLoginBounce("/profile"))
        assertEquals(2, h.requests.size)
        assertFalse(h.webSession.active)
    }

    @Test
    fun aLoginBounceWhileActiveMarksItInactiveUsesTheRetryAndNeverEndsTheNativeSession() = runBlocking {
        val h = Harness().signedIn()
        h.webSession.startFresh("/profile")
        h.webSession.admitLoad(REDEEM)
        h.webSession.onPageVisited("$ORIGIN/profile")
        assertTrue(h.webSession.active)

        val first = h.webSession.retryAfterLoginBounce("/profile")
        assertTrue(first is LoginBounceOutcome.Retried)
        assertFalse(h.webSession.active)
        assertTrue(h.session.state.value.isSignedIn)
        assertEquals(BEARER, h.tokens.token)

        assertEquals(LoginBounceOutcome.NativeSignIn, h.webSession.retryAfterLoginBounce("/profile"))
        assertTrue(h.session.state.value.isSignedIn)
        assertEquals(BEARER, h.tokens.token)
        assertFalse(h.requests.any { it.method == "DELETE" })
    }

    @Test
    fun aUserInitiatedHandoffOrAVerifiedLandingRearmsTheRetry() = runBlocking {
        val h = Harness().signedIn()
        h.webSession.retryAfterLoginBounce("/profile")
        assertEquals(LoginBounceOutcome.NativeSignIn, h.webSession.retryAfterLoginBounce("/profile"))

        h.webSession.startFresh("/profile") // the shopper tapped a tab again
        assertTrue(h.webSession.retryAfterLoginBounce("/profile") is LoginBounceOutcome.Retried)
        h.webSession.admitLoad(REDEEM)
        h.webSession.onPageVisited("$ORIGIN/profile") // landed with the cookie: linked
        assertTrue(h.webSession.active)
        assertTrue(h.webSession.retryAfterLoginBounce("/profile") is LoginBounceOutcome.Retried)
    }

    @Test
    fun aBounceWhileARequestIsRunningIsIgnored() = runBlocking {
        var outcome: LoginBounceOutcome? = null
        val h = Harness { outcome = webSession.retryAfterLoginBounce("/profile"); ok(handoffBody()) }.signedIn()

        h.webSession.startFresh("/profile")

        assertEquals(LoginBounceOutcome.Ignore, outcome)
    }

    // endregion

    // region permit cannot stick

    @Test
    fun aCancelledRetryReleasesItsPermit() = runBlocking {
        val h = Harness { awaitCancellation() }.signedIn()

        val job = launch(start = CoroutineStart.UNDISPATCHED) { h.webSession.retryAfterLoginBounce("/profile") }
        assertTrue(job.isActive) // suspended inside the request, permit held
        job.cancelAndJoin() // the composition scope went away

        // Not Ignore: the container is not stuck Busy. The one retry was spent, so the next bounce falls back.
        assertEquals(LoginBounceOutcome.NativeSignIn, h.webSession.retryAfterLoginBounce("/profile"))
    }

    @Test
    fun aRetryCancelledBeforeItStartsLeavesNothingBehind() = runBlocking {
        val h = Harness().signedIn()

        val job = launch(start = CoroutineStart.LAZY) { h.webSession.retryAfterLoginBounce("/profile") }
        job.cancelAndJoin()

        assertEquals(0, h.requests.size)
        assertTrue(h.webSession.retryAfterLoginBounce("/profile") is LoginBounceOutcome.Retried)
    }

    @Test
    fun aCancelledFreshHandoffReleasesItsPermit() = runBlocking {
        var hang = true
        val h = Harness { if (hang) awaitCancellation() else ok(handoffBody()) }.signedIn()

        val job = launch(start = CoroutineStart.UNDISPATCHED) { h.webSession.startFresh("/profile") }
        job.cancelAndJoin()
        hang = false

        assertEquals(LoginBounceOutcome.Retried(HandoffStep.Load(REDEEM)), h.webSession.retryAfterLoginBounce("/profile"))
    }

    // endregion

    // region ordering: sign-out, tabs

    @Test
    fun aRequestThatFinishesAfterResetIsDropped() = runBlocking {
        val h = Harness { webSession.reset(); ok(handoffBody()) }.signedIn()

        assertEquals(HandoffStep.Superseded, h.webSession.startFresh("/profile"))

        assertFalse(h.webSession.admitLoad(REDEEM)) // nothing was issued
        h.webSession.onPageVisited("$ORIGIN/profile")
        assertFalse(h.webSession.active)
    }

    @Test
    fun aRequestThatFinishesAfterTheNativeSessionEndedIsDropped() = runBlocking {
        val h = Harness { session.endExpiredSession(); ok(handoffBody()) }.signedIn()

        assertEquals(HandoffStep.Superseded, h.webSession.startFresh("/profile"))
        assertFalse(h.webSession.admitLoad(REDEEM))
    }

    @Test
    fun theLatestTapWinsOverARunningHandoff() = runBlocking {
        var calls = 0
        var inner: HandoffStep? = null
        val h = Harness {
            calls += 1
            if (calls == 1) inner = webSession.startFresh("/coupons") // a second tap while the first request runs
            ok(handoffBody())
        }.signedIn()

        val outer = h.webSession.startFresh("/profile#favorites")

        assertEquals(HandoffStep.Superseded, outer)
        assertEquals(HandoffStep.Load(REDEEM), inner)
        assertEquals(2, h.requests.size)
        assertEquals("""{"next":"/coupons"}""", h.requests.last().body)
    }

    @Test
    fun aDealsLoadCancelsAPendingSavedHandoff() = runBlocking {
        val h = Harness { assertTrue(webSession.admitLoad("$ORIGIN/coupons")); ok(handoffBody()) }.signedIn()

        assertEquals(HandoffStep.Superseded, h.webSession.startFresh("/profile#favorites"))

        assertFalse(h.webSession.admitLoad(REDEEM))
    }

    // endregion

    // region redeem URL: exactly the issued one

    @Test
    fun onlyTheIssuedRedeemUrlLoadsAndOnlyOnce() = runBlocking {
        val h = Harness().signedIn()
        assertFalse("nothing issued yet", h.webSession.admitLoad(REDEEM))

        h.webSession.startFresh("/profile")
        val other = "$ORIGIN/api/app/web-session/redeem?code=${CODE.reversed()}"
        assertFalse(h.webSession.admitLoad(other))
        assertFalse(h.webSession.admitLoad("$ORIGIN/API/app/web-session/redeem?code=$CODE"))
        assertFalse(h.webSession.admitLoad("$REDEEM&extra=1"))

        assertTrue(h.webSession.admitLoad(REDEEM))
        assertFalse("single use", h.webSession.admitLoad(REDEEM))
    }

    @Test
    fun aRefusedRedeemLookalikeDoesNotCancelThePendingRedeem() = runBlocking {
        val h = Harness().signedIn()
        h.webSession.startFresh("/profile")

        assertFalse(h.webSession.admitLoad("$ORIGIN/api/app/web-session/redeem?code=${CODE.reversed()}"))

        assertTrue(h.webSession.admitLoad(REDEEM))
        h.webSession.onPageVisited("$ORIGIN/profile")
        assertTrue(h.webSession.active)
    }

    // endregion

    @Test
    fun a401EndsTheNativeSessionAndAsksForSignIn() = runBlocking {
        val h = Harness { HttpResponse(401, """{"error":"unauthorized"}""") }.signedIn()

        assertEquals(HandoffStep.SignInRequired, h.webSession.startFresh("/profile"))

        assertNull(h.tokens.token)
        assertFalse(h.session.state.value.isSignedIn)
        assertEquals("Your session expired. Please sign in again.", h.session.state.value.errorMessage)
        assertNull(h.webSession.failure.value)
        assertFalse(h.webSession.active)
    }

    @Test
    fun aServerErrorShowsAFailureAndLoadsNothing() = runBlocking {
        var status = 503
        val h = Harness { if (status == 200) ok(handoffBody()) else HttpResponse(status, "{}") }.signedIn()

        val step = h.webSession.startFresh("/profile")

        assertTrue(step is HandoffStep.Failed)
        assertEquals((step as HandoffStep.Failed).message, h.webSession.failure.value)
        assertTrue(h.session.state.value.isSignedIn) // a server error does not sign the shopper out
        assertFalse(h.webSession.active)
        assertFalse(h.webSession.admitLoad(REDEEM))

        // Retry from the banner: the failure clears and the next attempt can succeed.
        status = 200
        assertTrue(h.webSession.startFresh("/profile") is HandoffStep.Load)
        assertNull(h.webSession.failure.value)
    }

    @Test
    fun noBearerMeansNoRequest() = runBlocking {
        val h = Harness(token = null).signedIn()

        assertEquals(HandoffStep.SignInRequired, h.webSession.startFresh("/profile"))
        assertEquals(0, h.requests.size)
    }

    @Test
    fun theWebSessionStaysOffWhenTheRequestFailsAfterAnEarlierLink() = runBlocking {
        var fail = false
        val h = Harness { if (fail) HttpResponse(500, "{}") else ok(handoffBody()) }.signedIn()
        h.webSession.startFresh("/profile")
        h.webSession.admitLoad(REDEEM)
        h.webSession.onPageVisited("$ORIGIN/profile")
        assertTrue(h.webSession.active)

        fail = true
        h.webSession.startFresh("/profile")

        assertFalse(h.webSession.active)
    }
}
