package com.devino.caramel

import com.devino.caramel.core.FavoritesStore
import com.devino.caramel.core.HttpRequest
import com.devino.caramel.core.HttpResponse
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FavoritesStoreTest {
    private fun server(
        favorites: List<String>,
        onPut: (HttpRequest) -> HttpResponse? = { null },
    ): (HttpRequest) -> HttpResponse = { request ->
        val path = request.url.removePrefix("https://example.test")
        val entries = favorites.joinToString(",") { """{"store":"$it","createdAt":"2026-10-01T00:00:00.000Z"}""" }
        when {
            request.method == "GET" && path == "/api/account/favorites" -> ok("""{"favorites":[$entries]}""")
            request.method == "PUT" -> onPut(request) ?: ok("""{"store":"${path.substringAfterLast('/')}","favorited":true}""")
            request.method == "DELETE" -> ok("""{"store":"${path.substringAfterLast('/')}","favorited":false}""")
            else -> HttpResponse(404, """{"error":"unexpected ${request.method} $path"}""")
        }
    }

    @Test
    fun signedOutTogglesLocallyAndPersists() = runBlocking {
        val (api, transport) = testApi(server(emptyList()))
        val lists = MemoryListStore()
        val store = FavoritesStore(api, lists) { null }

        store.toggle("  Nike.com ")
        store.toggle("b.com")
        assertEquals(listOf("b.com", "nike.com"), store.state.value.stores)
        assertTrue(store.contains("NIKE.com"))
        assertEquals(listOf("b.com", "nike.com"), lists.read(FavoritesStore.SAVED_KEY))

        store.toggle("nike.com")
        assertEquals(listOf("b.com"), store.state.value.stores)
        assertTrue(transport.requests.isEmpty())
    }

    @Test
    fun signedInToggleWritesToTheServerAndAdoptsItsKey() = runBlocking {
        val (api, transport) = testApi(server(emptyList()))
        val store = FavoritesStore(api, MemoryListStore()) { "tok" }
        store.toggle("www.nike.com")
        assertEquals(listOf("www.nike.com"), store.state.value.stores)
        assertEquals("PUT", transport.requests.single().method)
        assertEquals("Bearer tok", transport.requests.single().headers["Authorization"])
    }

    @Test
    fun signInMergesTheDeviceListWithTheAccountList() = runBlocking {
        val (api, transport) = testApi(server(listOf("acct.com")))
        val lists = MemoryListStore().apply { write(FavoritesStore.SAVED_KEY, listOf("local.com")) }
        var token: String? = null
        val store = FavoritesStore(api, lists) { token }

        token = "tok"
        store.sessionChanged()

        assertEquals(listOf("acct.com", "local.com"), store.state.value.stores)
        assertEquals(emptyList<String>(), lists.read(FavoritesStore.PENDING_KEY))
        assertEquals(listOf("GET", "PUT"), transport.requests.map { it.method })
        assertNull(store.state.value.errorMessage)
    }

    @Test
    fun aRateLimitedPushStaysPendingAndIsReported() = runBlocking {
        val (api, _) = testApi(server(emptyList()) { HttpResponse(429, """{"error":"slow down"}""") })
        val lists = MemoryListStore().apply { write(FavoritesStore.SAVED_KEY, listOf("local.com")) }
        var token: String? = null
        val store = FavoritesStore(api, lists) { token }

        token = "tok"
        store.sessionChanged()

        assertEquals(listOf("local.com"), store.state.value.stores)
        assertEquals(listOf("local.com"), lists.read(FavoritesStore.PENDING_KEY))
        assertTrue(store.state.value.errorMessage!!.startsWith("Too many changes at once. 1 saved store will sync"))
    }

    @Test
    fun signOutDropsTheAccountListAndTheQueue() = runBlocking {
        val (api, _) = testApi(server(emptyList()))
        val lists = MemoryListStore().apply {
            write(FavoritesStore.SAVED_KEY, listOf("a.com"))
            write(FavoritesStore.PENDING_KEY, listOf("a.com"))
        }
        val store = FavoritesStore(api, lists) { null }
        store.sessionChanged()
        assertEquals(emptyList<String>(), store.state.value.stores)
        assertEquals(emptyList<String>(), lists.read(FavoritesStore.PENDING_KEY))
    }

    @Test
    fun aFailedSyncKeepsTheCachedList() = runBlocking {
        val (api, _) = testApi { HttpResponse(500, """{"error":"down"}""") }
        val lists = MemoryListStore().apply { write(FavoritesStore.SAVED_KEY, listOf("a.com")) }
        val store = FavoritesStore(api, lists) { "tok" }
        store.refresh()
        assertEquals(listOf("a.com"), store.state.value.stores)
        assertNotNull(store.state.value.errorMessage)
    }
}
