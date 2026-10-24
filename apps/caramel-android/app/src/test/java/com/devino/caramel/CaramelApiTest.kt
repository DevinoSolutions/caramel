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
    fun recentlyWorkedDecodesAndLabelsDiscount() = runBlocking {
        val (api, transport) = testApi {
            ok(
                """{"coupons":[{"id":"1","code":"SAVE10","title":"10 off","storeDomain":"nike.com",
                "discountType":"PERCENTAGE","discountAmount":10,"lastWorkedAt":"2026-10-23T10:00:00.000Z","extra":"ignored"}]}""",
            )
        }
        val coupons = api.recentlyWorked()
        assertEquals("nike.com", coupons.single().storeDomain)
        assertEquals("10% off", coupons.single().discountLabel)
        val request = transport.requests.single()
        assertEquals("GET", request.method)
        assertEquals("https://example.test/api/coupons/recently-worked", request.url)
        assertEquals("req-1", request.headers["x-request-id"])
        assertNull(request.headers["Authorization"])
    }

    @Test
    fun topStoresDropsNullSites() = runBlocking {
        val (api, _) = testApi { ok("""{"sites":["a.com",null,"b.com"]}""") }
        assertEquals(listOf("a.com", "b.com"), api.topStores())
    }

    @Test
    fun storeOptionsSendsQueryAndLimit() = runBlocking {
        val (api, transport) = testApi { ok("""{"sites":["nike.com"]}""") }
        api.storeOptions("nike shoes")
        assertEquals("https://example.test/api/coupons/stores?q=nike%20shoes&limit=30", transport.requests.single().url)
    }

    @Test
    fun couponsDecodesSnakeCaseDiscountFields() = runBlocking {
        val (api, transport) = testApi {
            ok(
                """{"coupons":[{"id":"c1","code":"X","title":"T","description":"","discount_type":"FIXED","discount_amount":5,
                "expired":false,"keepsFailing":true}],"page":1,"limit":50,"total":1,"hasMore":false}""",
            )
        }
        val page = api.coupons("nike.com")
        assertEquals("\$5 off", page.coupons.single().discountLabel)
        assertEquals(true, page.coupons.single().keepsFailing)
        assertEquals("https://example.test/api/coupons?site=nike.com&page=1&limit=50", transport.requests.single().url)
    }

    @Test
    fun bearerIsSentOnAccountCalls() = runBlocking {
        val (api, transport) = testApi { ok("""{"username":"sam","image":null}""") }
        assertEquals("sam", api.me("tok").username)
        assertEquals("Bearer tok", transport.requests.single().headers["Authorization"])
    }

    @Test
    fun setFavoriteUsesPutAndDeleteAndReturnsServerKey() = runBlocking {
        val (api, transport) = testApi { ok("""{"store":"nike.com","favorited":true}""") }
        assertEquals("nike.com", api.setFavorite("www.nike.com", true, "tok"))
        api.setFavorite("nike.com", false, "tok")
        assertEquals(listOf("PUT", "DELETE"), transport.requests.map { it.method })
        assertEquals("https://example.test/api/account/favorites/www.nike.com", transport.requests.first().url)
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
    fun non2xxBecomesApiErrorWithServerMessageAndRequestId() {
        val (api, _) = testApi { HttpResponse(401, """{"error":"bad token"}""") }
        val error = assertThrows(ApiError::class.java) { runBlocking { api.me("tok") } }
        assertTrue(error.isUnauthorized)
        assertEquals("GET /api/extension/me failed (HTTP 401): bad token [request req-1]", error.message)
    }

    @Test
    fun nonJsonErrorBodyStillReportsTheStatus() {
        val (api, _) = testApi { HttpResponse(502, "<html>bad gateway</html>") }
        val error = assertThrows(ApiError::class.java) { runBlocking { api.topStores() } }
        assertEquals(502, error.status)
        assertEquals("unexpected status", error.detail)
        assertFalse(error.isRateLimited)
    }

    @Test
    fun networkFailureBecomesApiErrorWithoutStatus() {
        val (api, _) = testApi { throw IOException("offline") }
        val error = assertThrows(ApiError::class.java) { runBlocking { api.topStores() } }
        assertNull(error.status)
        assertEquals("GET /api/sites/top-sites failed (no response): offline [request req-1]", error.message)
    }

    @Test
    fun wrongShapeFailsLoudly() {
        val (api, _) = testApi { ok("""{"unexpected":true}""") }
        val error = assertThrows(ApiError::class.java) { runBlocking { api.topStores() } }
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
}
