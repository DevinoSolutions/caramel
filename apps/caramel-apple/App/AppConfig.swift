import Foundation

enum AppConfig {
    /// The production Caramel API. Every network call in the app goes here:
    /// the public JSON routes under /api (coupons, sites) and the bearer-gated
    /// account routes.
    static let apiBaseURL = URL(string: "https://grabcaramel.com")!

    /// BGTaskScheduler identifier for the local new-codes check (must also be
    /// listed in Info.plist BGTaskSchedulerPermittedIdentifiers via project.yml).
    static let alertsTaskIdentifier = "com.devino.Caramel.alerts-refresh"

    /// Scheme handed to ASWebAuthenticationSession as callbackURLScheme. The
    /// sheet closes itself when the web flow redirects to it, so it needs no
    /// Info.plist URL type and no apple-app-site-association.
    static let signInCallbackScheme = "com.devino.caramel"

    /// The redirect_uri sent to /api/extension/oauth/authorize and quoted back
    /// on the code exchange. MUST equal NATIVE_APP_REDIRECT_URI in
    /// apps/caramel-app/src/lib/auth/extensionOAuthRedirect.ts (the server
    /// accepts this one exact string).
    static let signInRedirectURI = "\(signInCallbackScheme)://auth/callback"
}
