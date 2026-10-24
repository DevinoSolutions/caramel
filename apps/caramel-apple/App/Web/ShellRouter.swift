import OSLog
import SwiftUI
import WebKit

/// Owns the tab selection and the web shells, and is the single place an incoming
/// URL (onOpenURL, a universal link) and a web-initiated sign-in are routed.
@MainActor
final class ShellRouter: ObservableObject {
    @Published var selection: RootTab
    /// The "Apple or Google?" prompt shown when a web page asked for /login or /signup.
    @Published var isChoosingSignInProvider = false

    let deals = WebShellModel(home: ShellDestination.deals.url)
    let stores = WebShellModel(home: ShellDestination.stores.url)
    let saved = WebShellModel(home: ShellDestination.saved.url)
    /// "Your Caramel account", pushed from the Account tab.
    let profile = WebShellModel(home: ShellDestination.profile.url)

    private static let log = Logger(subsystem: "com.devino.Caramel", category: "shell-router")

    init() {
        selection = ScreenshotLaunch.initialTab ?? .onboarding
        for model in [deals, stores, saved, profile] {
            model.onSignInRequested = { [weak self] in self?.isChoosingSignInProvider = true }
        }
        // App Store screenshot capture only: `-screenshotTab store:DOMAIN` opens that store's page.
        if let domain = ScreenshotLaunch.storeDomain, let page = ShellDestination.storePage(domain: domain) {
            deals.open(page)
        }
    }

    func model(for tab: RootTab) -> WebShellModel? {
        switch tab {
        case .deals: return deals
        case .search: return stores
        case .saved: return saved
        case .onboarding, .account: return nil
        }
    }

    /// Any URL handed to the app from outside (custom scheme, universal link).
    /// Same gate as in-page navigation: only an AppLinkGuard-approved Caramel URL
    /// is ever loaded, only on an allowlisted path (AppLinkGuard.incomingTarget;
    /// any other path lands on the Deals home), and it loads in the Deals shell.
    ///
    /// TODO(T-7842): universal links need the Associated Domains entitlement
    /// (applinks:grabcaramel.com) and an apple-app-site-association file on the web
    /// app; neither exists yet, so today only onOpenURL can reach this.
    func handleIncoming(_ url: URL) {
        // The sign-in callback is consumed by ASWebAuthenticationSession (SessionStore); not a page to show.
        if url.scheme?.lowercased() == AppConfig.signInCallbackScheme { return }
        guard let target = AppLinkGuard.incomingTarget(for: url, home: ShellDestination.deals.url) else {
            Self.log.error("Ignored an incoming URL that is not on the Caramel origin.")
            return
        }
        selection = .deals
        deals.open(target)
    }

    /// Sign-out and account deletion: the web side holds its own cookies and storage,
    /// so wipe all of it and send every shell back to its guarded home page. Without
    /// this the next person on the device would open the previous account's web session.
    func resetWebState() async {
        await WKWebsiteDataStore.default().removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
        for model in [deals, stores, saved, profile] {
            model.resetToHome()
        }
    }

    /// Runs the native sign-in a web page asked for. A failure is shown on the
    /// Account tab (where SessionStore's error banner lives) instead of vanishing.
    func signInFromWeb(_ provider: OAuthProvider, session: SessionStore) async {
        await session.signIn(with: provider)
        if session.errorMessage != nil {
            selection = .account
        }
        // TODO(T-7852): when `session.isSignedIn`, POST /api/app/web-session/handoff with
        // the bearer and load the returned redeem URL in the web shells so they show the
        // signed-in account. The endpoint does not exist yet, so the shells stay signed out.
    }
}
