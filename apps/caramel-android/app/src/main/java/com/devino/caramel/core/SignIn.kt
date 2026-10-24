package com.devino.caramel.core

import java.net.URI
import java.net.URISyntaxException
import java.net.URLDecoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

enum class SignInFailure(val userMessage: String) {
    SIGN_IN_NOT_STARTED("This sign-in is no longer waiting for an answer. Please try again."),
    PROVIDER_REFUSED("The sign-in was cancelled or refused."),
    MISSING_CODE("The sign-in did not return a code. Please try again."),
    STATE_MISMATCH("The sign-in response did not match the request. Please try again."),
    UNEXPECTED_CALLBACK("The sign-in returned to an unexpected address. Please try again."),
}

class SignInException(val failure: SignInFailure) : Exception(failure.userMessage)

/**
 * PKCE (RFC 7636, S256) for the sign-in. The app's callback scheme can be claimed by another
 * app on the device, so the code that comes back on it is only redeemable with a secret that
 * never travels through the scheme: the app sends the SHA-256 of a random verifier when it
 * starts the flow (the challenge) and reveals the verifier only in the direct exchange request.
 * The verifier lives in memory for the one sign-in and is never stored.
 */
class Pkce(val verifier: String, val challenge: String) {
    companion object {
        fun generate(random: SecureRandom = SecureRandom()): Pkce {
            val bytes = ByteArray(32)
            random.nextBytes(bytes)
            return fromVerifier(base64Url(bytes))
        }

        fun fromVerifier(verifier: String): Pkce {
            val digest = MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII))
            return Pkce(verifier, base64Url(digest))
        }

        /** Base64url without padding (RFC 4648 section 5), the form PKCE uses. */
        private fun base64Url(data: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(data)
    }
}

object SignInCallback {
    /**
     * The code from a sign-in callback, after checking it answers THIS request: the web app echoes
     * the signed state it issued, so a callback carrying anything else did not come from the flow
     * we started.
     *
     * The whole redirect target is checked, not just the scheme: any URL on our scheme would
     * otherwise pass as the sign-in answer. It must be [AppConfig.SIGN_IN_REDIRECT_URI], ignoring
     * only the query we asked for.
     */
    fun code(callback: String, expectedState: String): String {
        val actual = parse(callback)
        val expected = URI(AppConfig.SIGN_IN_REDIRECT_URI)
        if (actual.scheme != expected.scheme ||
            actual.host != expected.host ||
            actual.path != expected.path ||
            actual.port != -1 ||
            actual.userInfo != null ||
            actual.rawFragment != null
        ) {
            throw SignInException(SignInFailure.UNEXPECTED_CALLBACK)
        }
        val params = queryParameters(actual.rawQuery)
        if (params.containsKey("error")) throw SignInException(SignInFailure.PROVIDER_REFUSED)
        if (params["state"] != expectedState) throw SignInException(SignInFailure.STATE_MISMATCH)
        val code = params["code"]
        if (code.isNullOrEmpty()) throw SignInException(SignInFailure.MISSING_CODE)
        return code
    }

    /** The `state` query parameter of [callback], or null when there is none or the URL is malformed. */
    fun stateParam(callback: String): String? = try {
        queryParameters(URI(callback).rawQuery)["state"]
    } catch (_: URISyntaxException) {
        // Not a URL at all: it cannot be the answer to our request, so it has no state to match.
        null
    }

    private fun parse(callback: String): URI = try {
        URI(callback)
    } catch (e: URISyntaxException) {
        throw SignInException(SignInFailure.UNEXPECTED_CALLBACK).apply { initCause(e) }
    }

    private fun queryParameters(rawQuery: String?): Map<String, String> {
        if (rawQuery.isNullOrEmpty()) return emptyMap()
        val result = LinkedHashMap<String, String>()
        for (pair in rawQuery.split("&")) {
            if (pair.isEmpty()) continue
            val separator = pair.indexOf('=')
            val name = URLDecoder.decode(if (separator < 0) pair else pair.substring(0, separator), "UTF-8")
            val value = if (separator < 0) "" else URLDecoder.decode(pair.substring(separator + 1), "UTF-8")
            // First occurrence wins, like the iOS `items.first(where:)`.
            result.putIfAbsent(name, value)
        }
        return result
    }
}
