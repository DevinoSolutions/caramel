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

    /// Public pages linked from the Account tab's About section (App Review
    /// wants a support URL and a privacy policy reachable inside the app).
    /// There is no terms page on the site, so none is linked.
    static let websiteURL = URL(string: "https://grabcaramel.com")!
    static let supportURL = URL(string: "https://grabcaramel.com/support")!
    static let privacyPolicyURL = URL(string: "https://grabcaramel.com/privacy")!
    static let webAccountURL = URL(string: "https://grabcaramel.com/profile")!
}

/// App Store screenshot capture ONLY. The "App Store screenshots" workflow
/// (.github/workflows/apple-app-screenshots.yml) launches the simulator build
/// with `-screenshotTab <onboarding|deals|search|saved|account|store:DOMAIN>` so
/// it can photograph each screen without UI tests, and optionally
/// `-screenshotSavedStores a.com,b.com` to seed the Saved tab. Without these
/// arguments (every real launch) all of it is inert.
enum ScreenshotLaunch {
    private static func value(after flag: String) -> String? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: flag), arguments.indices.contains(index + 1) else { return nil }
        return arguments[index + 1]
    }

    private static let storePrefix = "store:"

    /// True when the capture workflow launched the app. The unsigned simulator
    /// build has no keychain entitlement (OSStatus -34018), so the Account tab
    /// hides that environment-only error banner in screenshots; real launches
    /// never pass the argument and always show it.
    static var isActive: Bool { value(after: "-screenshotTab") != nil }

    /// Text typed into the Search tab, so the shot shows results instead of the A-Z browse list.
    static var searchQuery: String? { value(after: "-screenshotSearchQuery") }

    /// The tab to open on; `store:DOMAIN` opens the Deals tab.
    static var initialTab: RootTab? {
        guard let raw = value(after: "-screenshotTab") else { return nil }
        if raw.hasPrefix(storePrefix) { return .deals }
        return RootTab(rawValue: raw)
    }

    /// The store page to push on top of the Deals tab, if requested.
    static var storeDomain: String? {
        guard let raw = value(after: "-screenshotTab"), raw.hasPrefix(storePrefix) else { return nil }
        let domain = String(raw.dropFirst(storePrefix.count))
        return domain.isEmpty ? nil : domain
    }

    /// Writes the saved-stores list before FavoritesStore reads it.
    static func seedSavedStoresIfRequested() {
        guard let raw = value(after: "-screenshotSavedStores") else { return }
        let stores = raw.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces).lowercased() }.filter { !$0.isEmpty }
        AppGroup.defaults.set(stores, forKey: AppGroup.Key.savedStores)
    }
}
