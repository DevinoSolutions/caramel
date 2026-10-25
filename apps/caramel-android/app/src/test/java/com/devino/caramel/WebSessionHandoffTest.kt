package com.devino.caramel

import com.devino.caramel.core.CaramelApi
import com.devino.caramel.core.HttpRequest
import com.devino.caramel.core.HttpResponse
import com.devino.caramel.core.HttpTransport
import com.devino.caramel.core.SessionStore
import com.devino.caramel.web.HandoffNext
import com.devino.caramel.web.HandoffStep
import com.devino.caramel.web.LoginBounceDecision
import com.devino.caramel.web.RedeemRequest
import com.devino.caramel.web.RedeemUrl
import com.devino.caramel.web.ShellTab
import com.devino.caramel.web.WebSessionHandoff
import com.devino.caramel.web.WebSessionHandoffClient
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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

class WebSessionHandoffTest {
    private class Harness(
        token: String? = BEARER,
        handler: suspend (HttpRequest, WebSessionHandoff) -> HttpResponse = { _, _ -> ok(handoffBody()) },
    ) {
        val requests = mutableListOf<HttpRequest>()
        val tokens = MemoryTokenStore(token)
        lateinit var webSession: WebSessionHandoff
        val session: SessionStore

        init {
            val transport = object : HttpTransport {
                override suspend fun execute(request: HttpRequest): HttpResponse {
                    requests += request
                    return handler(request, webSession)
                }
            }
            val api = CaramelApi("https://example.test", transport) { "req-${requests.size + 1}" }
            session = SessionStore(api, tokens)
            webSession = WebSessionHandoff(WebSessionHandoffClient(api), session)
        }
    }

    private fun Harness.signedIn(): Harness = also { runBlocking { it.session.load() } }

    @Test
    fun webSessionIsActiveOnlyAfterTheRedeemLandsOnAnAllowlistedPath() = runBlocking {
        val h = Harness().signedIn()
        assertFalse(h.webSession.active)

        val step = h.webSession.startFresh("/profile")
        assertEquals(HandoffStep.Load(REDEEM), step)
        assertFalse("a redeem URL handed out is not a landing", h.webSession.active)

        h.webSession.onPageVisited(REDEEM)
        h.webSession.onPageVisited("$ORIGIN/login?error=handoff_expired")
        h.webSession.onPageVisited("https://evil.com/profile")
        assertFalse(h.webSession.active)

        h.webSession.onPageVisited("$ORIGIN/profile")
        assertTrue(h.webSession.active)
    }

    @Test
    fun aLandingThatDidNotFollowARedeemDoesNotActivate() = runBlocking {
        val h = Harness().signedIn()
        h.webSession.onPageVisited("$ORIGIN/coupons") // no handoff yet
        assertFalse(h.webSession.active)

        h.webSession.startFresh("/profile")
        h.webSession.abandonInFlight() // the shopper loaded something else before the redeem landed
        h.webSession.onPageVisited("$ORIGIN/coupons")
        assertFalse(h.webSession.active)
    }

    @Test
    fun resetClearsTheWebSession() = runBlocking {
        val h = Harness().signedIn()
        h.webSession.startFresh("/profile")
        h.webSession.onPageVisited("$ORIGIN/profile")
        assertTrue(h.webSession.active)

        h.webSession.reset() // sign-out or account deletion
        assertFalse(h.webSession.active)
        h.webSession.onPageVisited("$ORIGIN/profile") // nothing in flight: stays inactive
        assertFalse(h.webSession.active)
    }

    @Test
    fun aNewHandoffStartsFromNoWebSession() = runBlocking {
        val h = Harness().signedIn()
        h.webSession.startFresh("/profile")
        h.webSession.onPageVisited("$ORIGIN/profile")
        assertTrue(h.webSession.active)

        h.webSession.startFresh("/profile") // a different person signed in, say
        assertFalse(h.webSession.active)
    }

    @Test
    fun anExpiredRedeemGetsExactlyOneFreshHandoffThenNativeSignIn() = runBlocking {
        val h = Harness().signedIn()
        assertTrue(h.webSession.startFresh("/profile") is HandoffStep.Load)
        assertEquals(1, h.requests.size)

        // The redeem answered 303 -> /login?error=handoff_expired: first bounce retries once.
        assertEquals(LoginBounceDecision.RETRY_HANDOFF, h.webSession.onLoginWhileUnlinked())
        assertTrue(h.webSession.continueRetry("/profile") is HandoffStep.Load)
        assertEquals(2, h.requests.size)

        // It bounced again: no third handoff, native sign-in, and it stays that way.
        assertEquals(LoginBounceDecision.NATIVE_SIGN_IN, h.webSession.onLoginWhileUnlinked())
        assertEquals(LoginBounceDecision.NATIVE_SIGN_IN, h.webSession.onLoginWhileUnlinked())
        assertEquals(2, h.requests.size)
        assertFalse(h.webSession.active)
    }

    @Test
    fun aUserInitiatedHandoffOrALandingRearmsTheRetry() = runBlocking {
        val h = Harness().signedIn()
        assertEquals(LoginBounceDecision.RETRY_HANDOFF, h.webSession.onLoginWhileUnlinked())
        h.webSession.continueRetry("/profile")
        assertEquals(LoginBounceDecision.NATIVE_SIGN_IN, h.webSession.onLoginWhileUnlinked())

        h.webSession.startFresh("/profile") // the shopper tapped a tab again
        assertEquals(LoginBounceDecision.RETRY_HANDOFF, h.webSession.onLoginWhileUnlinked())
        h.webSession.continueRetry("/profile")
        h.webSession.onPageVisited("$ORIGIN/profile") // landed: linked
        assertTrue(h.webSession.active)
    }

    @Test
    fun aBounceWhileARequestIsRunningIsIgnored() = runBlocking {
        var decision: LoginBounceDecision? = null
        val h = Harness { _, webSession ->
            decision = webSession.onLoginWhileUnlinked()
            ok(handoffBody())
        }.signedIn()

        h.webSession.startFresh("/profile")

        assertEquals(LoginBounceDecision.IGNORE, decision)
    }

    @Test
    fun aSecondHandoffWhileOneIsRunningIsBusy() = runBlocking {
        var inner: HandoffStep? = null
        val h = Harness { _, webSession ->
            inner = webSession.startFresh("/coupons")
            ok(handoffBody())
        }.signedIn()

        val outer = h.webSession.startFresh("/profile")

        assertEquals(HandoffStep.Busy, inner)
        assertTrue(outer is HandoffStep.Load)
        assertEquals(1, h.requests.size)
    }

    @Test
    fun aRequestThatFinishesAfterSignOutIsDropped() = runBlocking {
        val h = Harness { _, webSession ->
            webSession.reset()
            ok(handoffBody())
        }.signedIn()

        assertEquals(HandoffStep.Superseded, h.webSession.startFresh("/profile"))
        h.webSession.onPageVisited("$ORIGIN/profile")
        assertFalse(h.webSession.active)
    }

    @Test
    fun a401EndsTheNativeSessionAndAsksForSignIn() = runBlocking {
        val h = Harness { _, _ -> HttpResponse(401, """{"error":"unauthorized"}""") }.signedIn()

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
        val h = Harness { _, _ -> if (status == 200) ok(handoffBody()) else HttpResponse(status, "{}") }.signedIn()

        val step = h.webSession.startFresh("/profile")

        assertTrue(step is HandoffStep.Failed)
        assertEquals((step as HandoffStep.Failed).message, h.webSession.failure.value)
        assertTrue(h.session.state.value.isSignedIn) // a server error does not sign the shopper out
        assertFalse(h.webSession.active)

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
        val h = Harness { _, _ -> if (fail) HttpResponse(500, "{}") else ok(handoffBody()) }.signedIn()
        h.webSession.startFresh("/profile")
        h.webSession.onPageVisited("$ORIGIN/profile")
        assertTrue(h.webSession.active)

        fail = true
        h.webSession.startFresh("/profile")

        assertFalse(h.webSession.active)
    }
}
