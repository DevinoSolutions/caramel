package com.devino.caramel.core

import com.devino.caramel.BuildConfig

/** Constants mirrored from apps/caramel-apple/App/AppConfig.swift. */
object AppConfig {
    /**
     * The Caramel API. Every network call in the app goes here. https://grabcaramel.com in debug and release;
     * ONLY the dev-only `devproof` build type points it at dev.grabcaramel.com (app/build.gradle.kts).
     */
    const val API_BASE_URL = BuildConfig.API_BASE_URL

    /** Scheme of the sign-in callback; also declared as the intent filter in AndroidManifest.xml. */
    const val SIGN_IN_SCHEME = "com.devino.caramel"

    /**
     * The redirect_uri sent to /api/extension/oauth/authorize and quoted back on the code
     * exchange. MUST equal NATIVE_APP_REDIRECT_URI in
     * apps/caramel-app/src/lib/auth/extensionOAuthRedirect.ts (the server accepts this one
     * exact string, for every platform).
     */
    const val SIGN_IN_REDIRECT_URI = "$SIGN_IN_SCHEME://auth/callback"

    /**
     * Caramel's WEB OAuth client (the server's GOOGLE_CLIENT_ID), passed to Credential Manager as
     * serverClientId so the Google ID token's audience is the one
     * POST /api/extension/oauth/google-id-token verifies. Google only issues it to this package
     * when the same Cloud project also has an Android OAuth client for com.devino.caramel with
     * the signing certificate's SHA-1.
     */
    const val GOOGLE_SERVER_CLIENT_ID = "907782110658-v939qn59qc27bbngbvrp0kfko79gdidi.apps.googleusercontent.com"

    /** The site the WebView shell shows; AppLinkGuard.APP_ORIGIN is the same string (AppLinkGuardTest pins it). */
    const val WEBSITE_URL = API_BASE_URL
}
