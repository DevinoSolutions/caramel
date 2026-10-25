package com.devino.caramel

import com.devino.caramel.core.Pkce
import com.devino.caramel.core.SignInCallback
import com.devino.caramel.core.SignInException
import com.devino.caramel.core.SignInFailure
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class SignInTest {
    @Test
    fun pkceMatchesTheRfc7636Vector() {
        val pkce = Pkce.fromVerifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", pkce.challenge)
    }

    @Test
    fun generatedVerifiersAreUrlSafeAndDistinct() {
        val a = Pkce.generate()
        val b = Pkce.generate()
        assertNotEquals(a.verifier, b.verifier)
        assertEquals(43, a.verifier.length)
        assertTrue(a.verifier.matches(Regex("[A-Za-z0-9_-]+")))
    }

    private fun failure(callback: String, state: String = "s1"): SignInFailure =
        assertThrows(SignInException::class.java) { SignInCallback.code(callback, state) }.failure

    @Test
    fun acceptsTheExactRedirectWithMatchingState() {
        assertEquals("abc", SignInCallback.code("com.devino.caramel://auth/callback?code=abc&state=s1", "s1"))
    }

    @Test
    fun ignoresAFragmentTheBrowserCarriedOverTheRedirect() {
        assertEquals("abc", SignInCallback.code("com.devino.caramel://auth/callback?code=abc&state=s1#", "s1"))
        assertEquals("abc", SignInCallback.code("com.devino.caramel://auth/callback?code=abc&state=s1#frag", "s1"))
        // The state check still applies with a fragment.
        assertEquals(SignInFailure.STATE_MISMATCH, failure("com.devino.caramel://auth/callback?code=abc&state=forged#"))
    }

    @Test
    fun decodesPercentEncodedValues() {
        assertEquals("a b+c", SignInCallback.code("com.devino.caramel://auth/callback?state=s%201&code=a%20b%2Bc", "s 1"))
    }

    @Test
    fun rejectsAnyOtherTarget() {
        assertEquals(SignInFailure.UNEXPECTED_CALLBACK, failure("com.devino.caramel://auth/other?code=abc&state=s1"))
        assertEquals(SignInFailure.UNEXPECTED_CALLBACK, failure("com.devino.caramel://evil/callback?code=abc&state=s1"))
        assertEquals(SignInFailure.UNEXPECTED_CALLBACK, failure("https://auth/callback?code=abc&state=s1"))
        assertEquals(SignInFailure.UNEXPECTED_CALLBACK, failure("com.devino.caramel://user@auth/callback?code=abc&state=s1"))
        assertEquals(SignInFailure.UNEXPECTED_CALLBACK, failure("com.devino.caramel://auth:80/callback?code=abc&state=s1"))
        assertEquals(SignInFailure.UNEXPECTED_CALLBACK, failure("not a url"))
    }

    @Test
    fun rejectsProviderErrorStateMismatchAndMissingCode() {
        assertEquals(SignInFailure.PROVIDER_REFUSED, failure("com.devino.caramel://auth/callback?error=access_denied&state=s1"))
        assertEquals(SignInFailure.STATE_MISMATCH, failure("com.devino.caramel://auth/callback?code=abc&state=other"))
        assertEquals(SignInFailure.STATE_MISMATCH, failure("com.devino.caramel://auth/callback?code=abc"))
        assertEquals(SignInFailure.MISSING_CODE, failure("com.devino.caramel://auth/callback?state=s1"))
        assertEquals(SignInFailure.MISSING_CODE, failure("com.devino.caramel://auth/callback?code=&state=s1"))
    }
}
