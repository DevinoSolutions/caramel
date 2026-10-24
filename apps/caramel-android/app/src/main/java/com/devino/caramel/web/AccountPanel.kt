package com.devino.caramel.web

/** What the native "Account & privacy" dialog offers. */
enum class AccountAction {
    SIGN_IN,
    SIGN_OUT,
    DELETE_ACCOUNT,
    PRIVACY_POLICY,
}

/**
 * Pure content of the native "Account & privacy" dialog (reachable from the shell's top bar). Kept
 * native because Google Play's account-deletion policy (and Apple 5.1.1(v) for the iOS twin) needs
 * in-app deletion while the app offers sign-in, and the web /profile has none yet.
 * TODO(T-7505): once the web deletion page ships and the WebView shows it, this can move to the web.
 */
object AccountPanel {
    /** The app reads only a username from the server (never the email), so that is what is shown. */
    fun signedInLine(isSignedIn: Boolean, username: String?): String = when {
        !isSignedIn -> "You are not signed in."
        username.isNullOrBlank() -> "You are signed in."
        else -> "Signed in as $username."
    }

    /** Delete and sign-out exist only while signed in; the privacy policy is always there. */
    fun actions(isSignedIn: Boolean): List<AccountAction> =
        if (isSignedIn) {
            listOf(AccountAction.SIGN_OUT, AccountAction.DELETE_ACCOUNT, AccountAction.PRIVACY_POLICY)
        } else {
            listOf(AccountAction.SIGN_IN, AccountAction.PRIVACY_POLICY)
        }
}
