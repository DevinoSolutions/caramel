import Foundation

enum AppConfig {
    /// The production Caramel API. Every network call in the app goes here:
    /// the public JSON routes under /api (coupons, sites) and the bearer-gated
    /// account routes.
    static let apiBaseURL = URL(string: "https://grabcaramel.com")!

    /// BGTaskScheduler identifier for the local new-codes check (must also be
    /// listed in Info.plist BGTaskSchedulerPermittedIdentifiers via project.yml).
    static let alertsTaskIdentifier = "com.devino.Caramel.alerts-refresh"

    /// Scheme handed to ASWebAuthenticationSession. Nothing redirects to it yet.
    /// TODO(T-4906): the web OAuth flow ends on an HTML page, not on an app
    /// redirect, so the sheet is closed by the app once /poll yields the token.
    static let signInCallbackScheme = "caramel-signin"
}
