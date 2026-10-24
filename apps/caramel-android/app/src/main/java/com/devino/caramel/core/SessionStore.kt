package com.devino.caramel.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withContext
import kotlin.coroutines.CoroutineContext

/** Where the session bearer lives (an Android Keystore-encrypted file in production). */
interface TokenStore {
    /** Throws [TokenStoreException] when a stored token exists but cannot be read. */
    fun read(): String?

    fun write(token: String)

    fun delete()
}

class TokenStoreException(message: String, cause: Throwable? = null) : Exception(message, cause)

data class SessionState(
    val token: String? = null,
    val username: String? = null,
    val isSigningIn: Boolean = false,
    val errorMessage: String? = null,
) {
    val isSignedIn: Boolean get() = token != null
}

/**
 * The signed-in state: Apple / Google through the web OAuth flow in a browser tab (Custom Tabs,
 * no Google Play Services, so the same build runs on Fire devices), then the bearer in [TokenStore].
 * The same flow, endpoints and PKCE as apps/caramel-apple SessionStore.swift.
 */
class SessionStore(
    private val api: CaramelApi,
    private val tokens: TokenStore,
    // Keystore work is blocking crypto: never on the main thread.
    private val io: CoroutineContext = Dispatchers.IO,
    private val newPkce: () -> Pkce = { Pkce.generate() },
) {
    private class PendingSignIn(val provider: OAuthProvider, val state: String, val pkce: Pkce)

    private val mutableState = MutableStateFlow(SessionState())
    val state: StateFlow<SessionState> = mutableState.asStateFlow()

    private var pending: PendingSignIn? = null

    val token: String? get() = mutableState.value.token

    /** Reads the stored bearer. Call once at launch, before [validate]. */
    suspend fun load() {
        try {
            val stored = withContext(io) { tokens.read() }
            mutableState.update { it.copy(token = stored) }
        } catch (e: TokenStoreException) {
            mutableState.update { it.copy(errorMessage = e.message) }
        }
    }

    fun dismissError() {
        mutableState.update { it.copy(errorMessage = null) }
    }

    fun reportError(message: String) {
        mutableState.update { it.copy(errorMessage = message, isSigningIn = false) }
        pending = null
    }

    /** Confirms the stored bearer is still alive (a 401 means it expired or was revoked). */
    suspend fun validate() {
        val bearer = token ?: return
        try {
            val me = api.me(bearer)
            mutableState.update { it.copy(username = me.username) }
        } catch (e: ApiError) {
            if (e.isUnauthorized) {
                clearLocalSession()
                mutableState.update { it.copy(errorMessage = "Your session expired. Please sign in again.") }
            } else {
                mutableState.update { it.copy(errorMessage = e.message) }
            }
        }
    }

    /**
     * Step 1: asks the server for the provider URL. Returns the URL to open in a browser tab, or
     * null with [SessionState.errorMessage] set. The answer arrives in [completeSignIn].
     */
    suspend fun beginSignIn(provider: OAuthProvider): String? {
        mutableState.update { it.copy(isSigningIn = true, errorMessage = null) }
        return try {
            val pkce = newPkce()
            val start = api.oauthAuthorize(provider, pkce.challenge)
            pending = PendingSignIn(provider, start.state, pkce)
            start.authorizationUrl
        } catch (e: ApiError) {
            mutableState.update { it.copy(isSigningIn = false, errorMessage = e.message) }
            null
        }
    }

    /** The shopper came back from the browser tab without a callback (closed it): not an error to report. */
    fun abandonSignIn() {
        if (pending == null) return
        pending = null
        mutableState.update { it.copy(isSigningIn = false) }
    }

    /**
     * Step 2: the callback URL the browser tab redirected to (the app's intent filter).
     *
     * The pending sign-in is consumed ONLY by a callback that echoes its signed state. Any other
     * VIEW intent on our scheme (another app, a stray link) is refused and leaves the real
     * sign-in waiting for its answer.
     */
    suspend fun completeSignIn(callbackUrl: String) {
        val current = pending
        if (current == null) {
            mutableState.update { it.copy(isSigningIn = false, errorMessage = SignInFailure.SIGN_IN_NOT_STARTED.userMessage) }
            return
        }
        if (SignInCallback.stateParam(callbackUrl) != current.state) {
            mutableState.update { it.copy(errorMessage = SignInFailure.STATE_MISMATCH.userMessage) }
            return
        }
        pending = null
        try {
            val code = SignInCallback.code(callbackUrl, current.state)
            val result = api.oauthExchange(current.provider, code, current.state, current.pkce.verifier)
            withContext(io) { tokens.write(result.token) }
            mutableState.update {
                it.copy(token = result.token, username = result.username, isSigningIn = false, errorMessage = null)
            }
        } catch (e: SignInException) {
            mutableState.update { it.copy(isSigningIn = false, errorMessage = e.message) }
        } catch (e: ApiError) {
            mutableState.update { it.copy(isSigningIn = false, errorMessage = e.message) }
        } catch (e: TokenStoreException) {
            mutableState.update { it.copy(isSigningIn = false, errorMessage = e.message) }
        }
    }

    /**
     * Signs out: clears the on-device session and revokes the bearer on the server
     * (DELETE /api/extension/session). The local session is cleared even when the revoke fails, so
     * the shopper is never stuck signed in, and the failure is shown rather than swallowed.
     */
    suspend fun signOut() {
        val bearer = token
        mutableState.update { it.copy(errorMessage = null) }
        clearLocalSession()
        if (bearer == null) return
        try {
            api.revokeSession(bearer)
        } catch (e: ApiError) {
            val revokeFailure = "Signed out on this device, but the server could not end the session: ${e.message}"
            mutableState.update { state ->
                state.copy(errorMessage = listOfNotNull(state.errorMessage, revokeFailure).joinToString("\n"))
            }
        }
    }

    /**
     * Deletes the account on the server (POST /api/account/delete, which also ends every session,
     * this one included) and clears the local session. Returns false, with the error set, when the
     * server refused: nothing was deleted and the shopper stays signed in.
     */
    suspend fun deleteAccount(): Boolean {
        val bearer = token ?: return false
        try {
            api.deleteAccount(bearer)
        } catch (e: ApiError) {
            if (e.isUnauthorized) {
                // The session is already dead, so there is nothing left to delete under it.
                clearLocalSession()
                mutableState.update { it.copy(errorMessage = "Your session expired. Please sign in again.") }
            } else {
                mutableState.update { it.copy(errorMessage = "Could not delete your account: ${e.message}") }
            }
            return false
        }
        clearLocalSession()
        return true
    }

    private suspend fun clearLocalSession() {
        var failure: String? = null
        try {
            withContext(io) { tokens.delete() }
        } catch (e: TokenStoreException) {
            failure = e.message
        }
        mutableState.update { it.copy(token = null, username = null, errorMessage = failure ?: it.errorMessage) }
    }
}
