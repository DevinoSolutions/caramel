package com.devino.caramel

import com.devino.caramel.web.AccountAction
import com.devino.caramel.web.AccountPanel
import com.devino.caramel.web.AppLinkGuard
import com.devino.caramel.web.ShellRoutes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AccountPanelTest {
    @Test
    fun signedInOffersSignOutAndDeletionAndThePrivacyPolicy() {
        assertEquals(
            listOf(AccountAction.SIGN_OUT, AccountAction.DELETE_ACCOUNT, AccountAction.PRIVACY_POLICY),
            AccountPanel.actions(isSignedIn = true),
        )
    }

    @Test
    fun signedOutOffersSignInAndThePrivacyPolicyButNeverDeletion() {
        val actions = AccountPanel.actions(isSignedIn = false)
        assertEquals(listOf(AccountAction.SIGN_IN, AccountAction.PRIVACY_POLICY), actions)
        assertTrue(AccountAction.DELETE_ACCOUNT !in actions)
        assertTrue(AccountAction.SIGN_OUT !in actions)
    }

    @Test
    fun theSignedInLineNamesTheUserWhenKnown() {
        assertEquals("You are not signed in.", AccountPanel.signedInLine(false, "sam"))
        assertEquals("Signed in as sam.", AccountPanel.signedInLine(true, "sam"))
        assertEquals("You are signed in.", AccountPanel.signedInLine(true, null))
        assertEquals("You are signed in.", AccountPanel.signedInLine(true, "  "))
    }

    @Test
    fun thePrivacyPolicyOpensThroughTheGuard() {
        assertEquals("https://grabcaramel.com/privacy", ShellRoutes.privacyUrl())
        assertEquals(ShellRoutes.privacyUrl(), AppLinkGuard.allowedTarget(ShellRoutes.privacyUrl()))
    }
}
