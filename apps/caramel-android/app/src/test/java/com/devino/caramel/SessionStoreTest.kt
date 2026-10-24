package com.devino.caramel

import com.devino.caramel.core.HttpResponse
import com.devino.caramel.core.OAuthProvider
import com.devino.caramel.core.Pkce
import com.devino.caramel.core.SessionStore
import com.devino.caramel.core.SignInFailure
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionStoreTest {
    private val pkce = Pkce.fromVerifier("verifier-for-tests")
    private val callback = "com.devino.caramel://auth/callback?code=code1&state=st"

    private fun routed(extra: (String, String) -> HttpResponse? = { _, _ -> null }) = testApi { request ->
        val path = request.url.removePrefix("https://example.test").substringBefore("?")
        extra(request.method, path) ?: when (path) {
            "/api/extension/oauth/authorize" -> ok("""{"authorizationUrl":"https://accounts.example/auth","state":"st"}""")
            "/api/extension/oauth" -> ok("""{"token":"bearer-1","username":"sam"}""")
            "/api/extension/me" -> ok("""{"username":"sam"}""")
            else -> HttpResponse(200, "{}")
        }
    }

    @Test
    fun signInStoresTheBearerAfterTheCallback() = runBlocking {
        val (api, transport) = routed()
        val tokens = MemoryTokenStore()
        val store = SessionStore(api, tokens) { pkce }

        assertEquals("https://accounts.example/auth", store.beginSignIn(OAuthProvider.GOOGLE))
        assertTrue(store.state.value.isSigningIn)
        store.completeSignIn(callback)

        assertEquals("bearer-1", tokens.token)
        assertEquals("sam", store.state.value.username)
        assertFalse(store.state.value.isSigningIn)
        assertNull(store.state.value.errorMessage)
        val exchange = transport.requests.last()
        assertTrue(exchange.body!!.contains("\"codeVerifier\":\"verifier-for-tests\""))
        assertTrue(exchange.body!!.contains("\"code\":\"code1\""))
    }

    @Test
    fun aCallbackWithTheWrongStateSignsNobodyInAndKeepsTheRealSignInWaiting() = runBlocking {
        val (api, transport) = routed()
        val tokens = MemoryTokenStore()
        val store = SessionStore(api, tokens) { pkce }
        store.beginSignIn(OAuthProvider.APPLE)
        store.completeSignIn("com.devino.caramel://auth/callback?code=code1&state=forged")

        assertNull(tokens.token)
        assertEquals(SignInFailure.STATE_MISMATCH.userMessage, store.state.value.errorMessage)
        assertTrue(store.state.value.isSigningIn)
        assertEquals(1, transport.requests.size) // only the authorize call: no exchange

        store.completeSignIn(callback) // the genuine answer still works
        assertEquals("bearer-1", tokens.token)
    }

    @Test
    fun completeSignInReportsWhetherTheCallbackWasAccepted() = runBlocking {
        val (api, _) = routed()
        val store = SessionStore(api, MemoryTokenStore()) { pkce }
        store.beginSignIn(OAuthProvider.GOOGLE)
        assertFalse(store.completeSignIn("com.devino.caramel://auth/callback?code=x&state=forged"))
        assertTrue(store.completeSignIn(callback))
        assertFalse(store.completeSignIn(callback)) // nothing pending any more
    }

    @Test
    fun aCallbackWithNoPendingSignInIsRefused() = runBlocking {
        val (api, transport) = routed()
        val store = SessionStore(api, MemoryTokenStore()) { pkce }
        store.completeSignIn(callback)
        assertEquals(SignInFailure.SIGN_IN_NOT_STARTED.userMessage, store.state.value.errorMessage)
        assertTrue(transport.requests.isEmpty())
    }

    @Test
    fun abandonedSignInClearsTheSpinnerWithoutAnError() = runBlocking {
        val (api, _) = routed()
        val store = SessionStore(api, MemoryTokenStore()) { pkce }
        store.beginSignIn(OAuthProvider.GOOGLE)
        store.abandonSignIn()
        assertFalse(store.state.value.isSigningIn)
        assertNull(store.state.value.errorMessage)
    }

    @Test
    fun authorizeFailureIsShown() = runBlocking {
        val (api, _) = routed { _, path -> if (path.endsWith("/authorize")) HttpResponse(500, """{"error":"down"}""") else null }
        val store = SessionStore(api, MemoryTokenStore()) { pkce }
        assertNull(store.beginSignIn(OAuthProvider.GOOGLE))
        assertTrue(store.state.value.errorMessage!!.contains("down"))
        assertFalse(store.state.value.isSigningIn)
    }

    @Test
    fun validateClearsASessionTheServerRejects() = runBlocking {
        val (api, _) = routed { _, path -> if (path == "/api/extension/me") HttpResponse(401, """{"error":"expired"}""") else null }
        val tokens = MemoryTokenStore("old")
        val store = SessionStore(api, tokens) { pkce }
        store.load()
        store.validate()
        assertNull(tokens.token)
        assertFalse(store.state.value.isSignedIn)
        assertEquals("Your session expired. Please sign in again.", store.state.value.errorMessage)
    }

    @Test
    fun signOutClearsLocallyEvenWhenTheRevokeFails() = runBlocking {
        val (api, _) = routed { method, _ -> if (method == "DELETE") HttpResponse(500, "{}") else null }
        val tokens = MemoryTokenStore("tok")
        val store = SessionStore(api, tokens) { pkce }
        store.load()
        store.signOut()
        assertNull(tokens.token)
        assertTrue(store.state.value.errorMessage!!.startsWith("Signed out on this device, but the server could not end the session"))
    }

    @Test
    fun deleteAccountSignsOutOnSuccessAndStaysSignedInOnRefusal() = runBlocking {
        val (okApi, okTransport) = routed()
        val okTokens = MemoryTokenStore("tok")
        val okStore = SessionStore(okApi, okTokens) { pkce }
        okStore.load()
        assertTrue(okStore.deleteAccount())
        assertNull(okTokens.token)
        assertEquals("/api/account/delete", okTransport.requests.single().url.removePrefix("https://example.test"))

        val (badApi, _) = routed { _, path -> if (path == "/api/account/delete") HttpResponse(403, """{"error":"nope"}""") else null }
        val badTokens = MemoryTokenStore("tok")
        val badStore = SessionStore(badApi, badTokens) { pkce }
        badStore.load()
        assertFalse(badStore.deleteAccount())
        assertEquals("tok", badTokens.token)
        assertTrue(badStore.state.value.errorMessage!!.startsWith("Could not delete your account"))
    }
}
