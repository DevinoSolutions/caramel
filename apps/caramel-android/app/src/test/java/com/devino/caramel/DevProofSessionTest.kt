package com.devino.caramel

import com.devino.caramel.core.AppConfig
import com.devino.caramel.core.DevProofSession
import com.devino.caramel.core.HttpResponse
import com.devino.caramel.core.SessionStore
import com.devino.caramel.core.TokenStore
import com.devino.caramel.core.TokenStoreException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** T-9413: the dev-only proof path's parsing and handoff into the session store. */
class DevProofSessionTest {
    // What POST /api/dev-proof/session returns: 32 random bytes as base64url, 43 characters.
    private val bearer = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v"

    @Test
    fun theExtraIsNamedAsTheRunbookAndTheAdbCommandSay() {
        assertEquals("devproof_session", DevProofSession.EXTRA_NAME)
    }

    @Test
    fun noExtraIsAnOrdinaryLaunch() {
        assertTrue(DevProofSession.parse(null) === DevProofSession.Extra.Absent)
    }

    @Test
    fun aServerShapedTokenIsTakenAsTheBearer() {
        assertEquals(43, bearer.length)
        val parsed = DevProofSession.parse(bearer)
        assertTrue(parsed is DevProofSession.Extra.Bearer)
        assertEquals(bearer, (parsed as DevProofSession.Extra.Bearer).token)
    }

    @Test
    fun anythingElseIsMalformedAndNeverTakenAsABearer() {
        val notBearers = listOf(
            "",
            " ",
            "short",
            "$bearer ",
            " $bearer",
            "$bearer\n",
            "Bearer $bearer",
            "$bearer!",
            "a".repeat(129),
            "https://dev.grabcaramel.com/api/dev-proof/session",
        )
        for (candidate in notBearers) {
            assertTrue("'$candidate' must be malformed", DevProofSession.parse(candidate) === DevProofSession.Extra.Malformed)
        }
    }

    @Test
    fun adoptingABearerStoresItAndValidateConfirmsItAgainstTheServer() = runBlocking {
        val (api, transport) = testApi { request ->
            if (request.url.endsWith("/api/extension/me")) ok("""{"username":"Devproof tester"}""") else HttpResponse(404, "{}")
        }
        val tokens = MemoryTokenStore()
        val store = SessionStore(api, tokens)

        store.adoptDevProofBearer(bearer)

        assertEquals(bearer, tokens.token)
        assertEquals(bearer, store.token)
        assertTrue(store.state.value.isSignedIn)
        assertTrue(transport.requests.isEmpty()) // adoption is local; the server is asked by validate()

        store.validate()

        assertEquals("Devproof tester", store.state.value.username)
        assertEquals(1, transport.requests.size)
        assertEquals("Bearer $bearer", transport.requests.single().headers["Authorization"])
    }

    @Test
    fun aBearerTheServerRejectsEndsTheSessionLoudly() = runBlocking {
        val (api, _) = testApi { HttpResponse(401, """{"error":"Unauthorized"}""") }
        val tokens = MemoryTokenStore()
        val store = SessionStore(api, tokens)

        store.adoptDevProofBearer(bearer)
        store.validate()

        assertNull(tokens.token)
        assertFalse(store.state.value.isSignedIn)
        assertEquals("Your session expired. Please sign in again.", store.state.value.errorMessage)
    }

    @Test
    fun aTokenStoreThatRefusesTheWriteIsShownNotSwallowed() = runBlocking {
        val (api, _) = testApi { ok("{}") }
        val refusing = object : TokenStore {
            override fun read(): String? = null

            override fun write(token: String) = throw TokenStoreException("The device could not store the session.")

            override fun delete() = Unit
        }
        val store = SessionStore(api, refusing)

        store.adoptDevProofBearer(bearer)

        assertNull(store.token)
        assertEquals("The device could not store the session.", store.state.value.errorMessage)
    }

    // The unit-test (debug) variant carries production. If this fails, the devproof build type's overrides leaked into
    // debug or release; see also tests/unit/android-devproof-never-ships.test.ts and the android-devproof-guard workflow.
    @Test
    fun debugAndReleaseCarryProductionAndNotTheDevProofSwitch() {
        assertFalse(BuildConfig.DEV_PROOF)
        assertEquals("https://grabcaramel.com", BuildConfig.API_BASE_URL)
        assertEquals("https://grabcaramel.com", AppConfig.API_BASE_URL)
        assertEquals("https://grabcaramel.com", AppConfig.WEBSITE_URL)
        assertEquals("com.devino.caramel", BuildConfig.APPLICATION_ID)
    }
}
