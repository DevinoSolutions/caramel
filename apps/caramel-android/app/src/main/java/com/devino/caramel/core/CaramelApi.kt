package com.devino.caramel.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.UUID

/**
 * A failed Caramel API call. Carries the request id sent as `x-request-id` so a failure shown
 * in the app can be found in the server logs / Sentry.
 */
class ApiError(
    val method: String,
    val path: String,
    val status: Int?,
    val requestId: String,
    val detail: String,
    cause: Throwable? = null,
) : Exception(
    "$method $path failed (${status?.let { "HTTP $it" } ?: "no response"}): $detail [request $requestId]",
    cause,
) {
    val isUnauthorized: Boolean get() = status == 401
    val isRateLimited: Boolean get() = status == 429
}

data class HttpRequest(
    val method: String,
    val url: String,
    val headers: Map<String, String>,
    val body: String?,
)

data class HttpResponse(val status: Int, val body: String)

/** A 2xx [HttpResponse] plus the request id it answered (kept for decode failures). */
class ApiResponse(val body: String, val requestId: String)

/** The one seam between the client and the network, so the client is unit-testable. */
fun interface HttpTransport {
    /** Returns every HTTP response (also non-2xx); throws IOException when there is none. */
    suspend fun execute(request: HttpRequest): HttpResponse
}

class HttpUrlConnectionTransport : HttpTransport {
    override suspend fun execute(request: HttpRequest): HttpResponse = withContext(Dispatchers.IO) {
        val connection = URL(request.url).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = request.method
            // The API never redirects a JSON call; following one would resend the bearer elsewhere.
            connection.instanceFollowRedirects = false
            connection.connectTimeout = TIMEOUT_MS
            connection.readTimeout = TIMEOUT_MS
            request.headers.forEach { (name, value) -> connection.setRequestProperty(name, value) }
            val body = request.body
            // PUT/POST always send a (possibly empty) body so the request carries Content-Length.
            if (body != null || request.method == "PUT" || request.method == "POST") {
                connection.doOutput = true
                connection.outputStream.use { it.write((body ?: "").toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
            HttpResponse(status, text)
        } finally {
            connection.disconnect()
        }
    }

    private companion object {
        const val TIMEOUT_MS = 20_000
    }
}

/**
 * Minimal typed client over the existing grabcaramel.com JSON API. Nothing here is new server
 * surface: each method is one existing route (the same ones apps/caramel-apple CaramelAPI.swift calls).
 */
class CaramelApi(
    private val baseUrl: String = AppConfig.API_BASE_URL,
    private val transport: HttpTransport = HttpUrlConnectionTransport(),
    private val newRequestId: () -> String = { UUID.randomUUID().toString() },
) {
    private val json = Json { ignoreUnknownKeys = true }

    @Serializable
    private class ErrorBody(val error: String? = null)

    /** Sends one request and returns the body of a 2xx with its request id. */
    suspend fun send(
        method: String,
        path: String,
        query: List<Pair<String, String>> = emptyList(),
        body: String? = null,
        bearer: String? = null,
    ): ApiResponse {
        val requestId = newRequestId()
        val headers = linkedMapOf("Accept" to "application/json", "x-request-id" to requestId)
        if (bearer != null) headers["Authorization"] = "Bearer $bearer"
        if (body != null) headers["Content-Type"] = "application/json"
        val response = try {
            transport.execute(HttpRequest(method, buildUrl(path, query), headers, body))
        } catch (e: IOException) {
            throw ApiError(method, path, null, requestId, e.message ?: e.javaClass.simpleName, e)
        }
        if (response.status !in 200..299) {
            val serverMessage = try {
                json.decodeFromString<ErrorBody>(response.body).error
            } catch (_: SerializationException) {
                // The error body is not our JSON shape (a proxy page, say): the status line still names the failure.
                null
            }
            throw ApiError(method, path, response.status, requestId, serverMessage ?: "unexpected status")
        }
        return ApiResponse(response.body, requestId)
    }

    private suspend inline fun <reified T> get(
        path: String,
        query: List<Pair<String, String>> = emptyList(),
        bearer: String? = null,
    ): T = decode(send("GET", path, query, bearer = bearer), "GET", path)

    private inline fun <reified T> decode(response: ApiResponse, method: String, path: String): T = try {
        json.decodeFromString<T>(response.body)
    } catch (e: SerializationException) {
        throw ApiError(method, path, null, response.requestId, "Response did not match the expected shape: ${e.message}", e)
    }

    // region Public catalog routes

    /** GET /api/coupons/recently-worked */
    suspend fun recentlyWorked(): List<RecentlyWorkedCoupon> =
        get<RecentlyWorkedResponse>("/api/coupons/recently-worked").coupons

    /** GET /api/sites/top-sites */
    suspend fun topStores(): List<String> = get<SitesResponse>("/api/sites/top-sites").sites.filterNotNull()

    /** GET /api/coupons/stores?q=&limit= (empty [query] browses). */
    suspend fun storeOptions(query: String, limit: Int = 30): List<String> =
        get<SitesResponse>("/api/coupons/stores", listOf("q" to query, "limit" to limit.toString())).sites.filterNotNull()

    /** GET /api/coupons?site=&page=&limit= */
    suspend fun coupons(site: String, page: Int = 1, limit: Int = 50): CouponsPage =
        get("/api/coupons", listOf("site" to site, "page" to page.toString(), "limit" to limit.toString()))

    // endregion

    // region Account routes (bearer)

    /** GET /api/extension/me */
    suspend fun me(bearer: String): MeResponse = get("/api/extension/me", bearer = bearer)

    /** GET /api/account/overview */
    suspend fun overview(bearer: String): OverviewResponse = get("/api/account/overview", bearer = bearer)

    /** GET /api/account/favorites */
    suspend fun favorites(bearer: String): List<String> =
        get<FavoritesResponse>("/api/account/favorites", bearer = bearer).favorites.map { it.store }

    /**
     * PUT or DELETE /api/account/favorites/:store. Returns the store key the server actually
     * wrote (it normalizes to the registrable domain).
     */
    suspend fun setFavorite(store: String, favorited: Boolean, bearer: String): String {
        val method = if (favorited) "PUT" else "DELETE"
        val path = "/api/account/favorites/$store"
        return decode<FavoriteWriteResponse>(send(method, path, bearer = bearer), method, path).store
    }

    /** GET /api/account/export (the JSON download), returned as the bytes of the body. */
    suspend fun exportData(bearer: String): ByteArray =
        send("GET", "/api/account/export", bearer = bearer).body.toByteArray(Charsets.UTF_8)

    /**
     * POST /api/account/delete. Deletes the account itself (the user, every session including this
     * bearer, linked sign-ins and synced data).
     */
    suspend fun deleteAccount(bearer: String) {
        send("POST", "/api/account/delete", body = confirmDeleteBody(), bearer = bearer)
    }

    /** DELETE /api/extension/session. Revokes THIS bearer on the server (idempotent). */
    suspend fun revokeSession(bearer: String) {
        send("DELETE", "/api/extension/session", bearer = bearer)
    }

    /**
     * POST /api/account/data/delete. Removes synced savings, followed stores and reports; it does
     * NOT delete the account (see [deleteAccount]).
     */
    suspend fun deleteSyncedData(bearer: String) {
        send("POST", "/api/account/data/delete", body = confirmDeleteBody(), bearer = bearer)
    }

    // endregion

    // region Sign-in routes (the extension OAuth flow with the app's redirect URI)

    /**
     * GET /api/extension/oauth/authorize with the app's own redirect URI. [codeChallenge] is the
     * PKCE S256 challenge: the server requires it for the app redirect and will only redeem the
     * code with the matching verifier.
     */
    suspend fun oauthAuthorize(provider: OAuthProvider, codeChallenge: String): OAuthAuthorizeResponse = get(
        "/api/extension/oauth/authorize",
        listOf(
            "provider" to provider.wireName,
            "redirect_uri" to AppConfig.SIGN_IN_REDIRECT_URI,
            "code_challenge" to codeChallenge,
            "code_challenge_method" to "S256",
        ),
    )

    /** POST /api/extension/oauth. Trades the code the browser returned for a session bearer. */
    suspend fun oauthExchange(
        provider: OAuthProvider,
        code: String,
        state: String,
        codeVerifier: String,
    ): OAuthSessionResult {
        val body = buildJsonObject {
            put("provider", provider.wireName)
            put("code", code)
            put("state", state)
            put("redirectUri", AppConfig.SIGN_IN_REDIRECT_URI)
            put("codeVerifier", codeVerifier)
        }.toString()
        return decode(send("POST", "/api/extension/oauth", body = body), "POST", "/api/extension/oauth")
    }

    // endregion

    private fun confirmDeleteBody(): String = buildJsonObject { put("confirm", "DELETE") }.toString()

    internal fun buildUrl(path: String, query: List<Pair<String, String>>): String {
        val encodedPath = path.split("/").joinToString("/") { encode(it) }
        val queryString = if (query.isEmpty()) "" else "?" + query.joinToString("&") { "${encode(it.first)}=${encode(it.second)}" }
        return baseUrl.trimEnd('/') + encodedPath + queryString
    }

    private fun encode(value: String): String = URLEncoder.encode(value, "UTF-8").replace("+", "%20")
}
