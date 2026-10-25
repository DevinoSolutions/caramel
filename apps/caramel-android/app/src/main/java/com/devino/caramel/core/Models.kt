package com.devino.caramel.core

import kotlinx.serialization.Serializable

// Wire shapes of the sign-in routes the shell still calls natively (the same ones
// apps/caramel-apple/App/Core/Models.swift decodes). The catalog, savings and favorites shapes
// went away with the native screens: grabcaramel.com renders those inside the WebView now.
// A server rename fails the decode loudly (ApiError) instead of rendering blanks.

/** GET /api/extension/me */
@Serializable
data class MeResponse(val username: String? = null, val image: String? = null)

enum class OAuthProvider(val wireName: String) {
    APPLE("apple"),
    GOOGLE("google"),
}

/**
 * GET /api/extension/oauth/authorize. `state` is the signed state the provider hands back on
 * the redirect; the app checks the callback echoes it.
 */
@Serializable
data class OAuthAuthorizeResponse(val authorizationUrl: String, val state: String)

/** POST /api/extension/oauth (200): the minted session. */
@Serializable
data class OAuthSessionResult(val token: String, val username: String? = null, val image: String? = null)

/**
 * POST /api/app/web-session/handoff (200). [url] is the one-time redeem URL (a credential: never log it);
 * the code in it expires after [expiresInSeconds].
 */
@Serializable
data class HandoffResponse(val url: String, val expiresInSeconds: Int = 0)
