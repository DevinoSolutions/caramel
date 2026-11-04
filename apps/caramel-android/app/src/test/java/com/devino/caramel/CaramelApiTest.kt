package com.devino.caramel

import com.devino.caramel.core.ApiError
import com.devino.caramel.core.HttpResponse
import com.devino.caramel.core.OAuthProvider
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

class CaramelApiTest {
    @Test
    fun bearerIsSentOnAccountCalls() = runBlocking {
        val (api, transport) = testApi { ok("""{"username":"sam","image":null}""") }
        assertEquals("sam", api.me("tok").username)
        val request = transport.requests.single()
        assertEquals("GET", request.method)
        assertEquals("https://example.test/api/extension/me", request.url)
        assertEquals("Bearer tok", request.headers["Authorization"])
        assertEquals("req-1", request.headers["x-request-id"])
    }

    @Test
    fun revokeSessionSendsDeleteWithTheBearer() = runBlocking {
        val (api, transport) = testApi { HttpResponse(200, "{}") }
        api.revokeSession("tok")
        val request = transport.requests.single()
        assertEquals("DELETE", request.method)
        assertEquals("https://example.test/api/extension/session", request.url)
        assertEquals("Bearer tok", request.headers["Authorization"])
        assertNull(request.body)
    }

    @Test
    fun non2xxBecomesApiErrorWithServerMessageAndRequestId() {
        val (api, _) = testApi { HttpResponse(401, """{"error":"bad token"}""") }
        val error = assertThrows(ApiError::class.java) { runBlocking { api.me("tok") } }
        assertTrue(error.isUnauthorized)
        assertEquals("GET /api/extension/me failed (HTTP 401): bad token [request req-1]", error.message)
    }

    @Test
    fun nonJsonErrorBodyStillReportsTheStatus() {
        val (api, _) = testApi { HttpResponse(502, "<html>bad gateway</html>") }
        val error = assertThrows(ApiError::class.java) { runBlocking { api.me("tok") } }
        assertEquals(502, error.status)
        assertEquals("unexpected status", error.detail)
        assertFalse(error.isRateLimited)
    }

    @Test
    fun networkFailureBecomesApiErrorWithoutStatus() {
        val (api, _) = testApi { throw IOException("offline") }
        val error = assertThrows(ApiError::class.java) { runBlocking { api.me("tok") } }
        assertNull(error.status)
        assertEquals("GET /api/extension/me failed (no response): offline [request req-1]", error.message)
    }

    @Test
    fun wrongShapeFailsLoudly() {
        val (api, _) = testApi { ok("""{"unexpected":true}""") }
        val error = assertThrows(ApiError::class.java) { runBlocking { api.oauthAuthorize(OAuthProvider.GOOGLE, "chal") } }
        assertTrue(error.detail.startsWith("Response did not match the expected shape"))
    }

    @Test
    fun oauthAuthorizeSendsTheAppRedirectAndPkceChallenge() = runBlocking {
        val (api, transport) = testApi { ok("""{"authorizationUrl":"https://accounts.example/auth","state":"s1"}""") }
        val start = api.oauthAuthorize(OAuthProvider.GOOGLE, "chal")
        assertEquals("s1", start.state)
        assertEquals(
            "https://example.test/api/extension/oauth/authorize?provider=google" +
                "&redirect_uri=com.devino.caramel%3A%2F%2Fauth%2Fcallback&code_challenge=chal&code_challenge_method=S256",
            transport.requests.single().url,
        )
    }

    @Test
    fun oauthExchangeBodyCarriesVerifierAndRedirect() = runBlocking {
        val (api, transport) = testApi { ok("""{"token":"bearer","username":"sam"}""") }
        val session = api.oauthExchange(OAuthProvider.APPLE, "code1", "s1", "verifier1")
        assertEquals("bearer", session.token)
        assertEquals(
            """{"provider":"apple","code":"code1","state":"s1","redirectUri":"com.devino.caramel://auth/callback","codeVerifier":"verifier1"}""",
            transport.requests.single().body,
        )
    }

    @Test
    fun deleteAccountPostsTheConfirmBody() = runBlocking {
        val (api, transport) = testApi { HttpResponse(200, "{}") }
        api.deleteAccount("tok")
        val request = transport.requests.single()
        assertEquals("POST", request.method)
        assertEquals("https://example.test/api/account/delete", request.url)
        assertEquals("""{"confirm":"DELETE"}""", request.body)
        assertEquals("application/json", request.headers["Content-Type"])
    }

    @Test
    fun googleIdTokenSignInPostsTheTokenToTheNativeRoute() = runBlocking {
        val (api, transport) = testApi { ok("""{"token":"bearer","username":"sam"}""") }
        val session = api.googleIdTokenSignIn("id-token-1")
        assertEquals("bearer", session.token)
        val request = transport.requests.single()
        assertEquals("POST", request.method)
        assertEquals("https://example.test/api/extension/oauth/google-id-token", request.url)
        assertEquals("""{"idToken":"id-token-1"}""", request.body)
    }
}
