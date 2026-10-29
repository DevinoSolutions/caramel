package com.devino.caramel.core

/** Constants mirrored from apps/caramel-apple/App/AppConfig.swift. */
object AppConfig {
    /** The production Caramel API. Every network call in the app goes here. */
    const val API_BASE_URL = "https://grabcaramel.com"

    /** Scheme of the sign-in callback; also declared as the intent filter in AndroidManifest.xml. */
    const val SIGN_IN_SCHEME = "com.devino.caramel"

    /**
     * The redirect_uri sent to /api/extension/oauth/authorize and quoted back on the code
     * exchange. MUST equal NATIVE_APP_REDIRECT_URI in
     * apps/caramel-app/src/lib/auth/extensionOAuthRedirect.ts (the server accepts this one
     * exact string, for every platform).
     */
    const val SIGN_IN_REDIRECT_URI = "$SIGN_IN_SCHEME://auth/callback"

    /** The site the WebView shell shows; AppLinkGuard.APP_ORIGIN is the same string (AppLinkGuardTest pins it). */
    const val WEBSITE_URL = "https://grabcaramel.com"
}
