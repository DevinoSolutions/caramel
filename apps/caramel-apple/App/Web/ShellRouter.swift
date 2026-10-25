import OSLog
import SwiftUI
import WebKit

/// Owns the tab selection and the web shells, and is the single place an incoming
/// URL (onOpenURL, a universal link), a web-initiated sign-in and the native-to-web
/// session handoff (T-7852) are routed.
///
/// The handoff: the native sign-in leaves a session bearer in the Keychain, but the
/// web views need the signed session cookie. While the shopper is signed in natively
/// and the web views have no web session, every page load is held, the bearer is
/// traded at POST /api/app/web-session/handoff for a one-time redeem URL, and that URL
/// is loaded in one shell (its 303 sets the cookie in the shared default data store,
/// so all four shells see it). WebSessionMachine holds the rules (one handoff at a
/// time, one fresh retry on `handoff_expired`, a 401 ends the native session).
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

    /// The handoff in flight: which shell loads the redeem URL and the page it should end on.
    private struct Handoff {
        let host: WebShellModel
        let target: URL
    }

    private let session: SessionStore
    private let handoffClient: WebSessionHandoffClient
    private var webSession = WebSessionMachine()
    private var handoff: Handoff?
    private var handoffTask: Task<Void, Never>?
    /// Loads asked for while a handoff was in flight, replayed once the web session exists.
    private var heldLoads: [ObjectIdentifier: (model: WebShellModel, url: URL)] = [:]

    private var allModels: [WebShellModel] { [deals, stores, saved, profile] }

    init(session: SessionStore, handoffClient: WebSessionHandoffClient = WebSessionHandoffClient()) {
        self.session = session
        self.handoffClient = handoffClient
        selection = ScreenshotLaunch.initialTab ?? .onboarding
        for model in allModels {
            model.onSignInRequested = { [weak self] in self?.isChoosingSignInProvider = true }
            model.webSessionGate = { [weak self] model, url in self?.holdForWebSession(model, url) ?? false }
            model.onRedeemOutcome = { [weak self] model, outcome in self?.redeemFinished(on: model, outcome) }
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
    /// The web session is over too, so a handoff in flight is abandoned first.
    func resetWebState() async {
        abandonWebSession()
        await WKWebsiteDataStore.default().removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
        for model in allModels {
            model.resetToHome()
        }
    }

    /// Runs the native sign-in a web page asked for. A failure is shown on the
    /// Account tab (where SessionStore's error banner lives) instead of vanishing.
    /// The web session itself starts from the session change (startWebSession, called
    /// by CaramelApp), so every sign-in entry point gets it, not just this one.
    func signInFromWeb(_ provider: OAuthProvider) async {
        await session.signIn(with: provider)
        if session.errorMessage != nil {
            selection = .account
        }
    }

    // MARK: Web session handoff (T-7852)

    /// A sign-in just completed (from any screen): give the web views a web session for
    /// this account. Any earlier web session is abandoned first, so a different account
    /// never reuses the previous one's cookie (the redeem overwrites it). The visible web
    /// tab, or Deals, hosts the redeem and ends on the page it was showing.
    func startWebSession() {
        abandonWebSession()
        let host = model(for: selection) ?? deals
        host.open(host.targetURL)
    }

    /// WebShellModel.webSessionGate: true when this load must wait for the handoff.
    private func holdForWebSession(_ model: WebShellModel, _ url: URL) -> Bool {
        guard session.isSignedIn else { return false }
        switch webSession.phase {
        case .active:
            return false
        case .handingOff:
            heldLoads[ObjectIdentifier(model)] = (model, url)
            return true
        case .inactive, .failed:
            startHandoff(host: model, target: url)
            return true
        }
    }

    private func startHandoff(host: WebShellModel, target: URL) {
        guard webSession.begin() else { return }
        handoff = Handoff(host: host, target: target)
        requestHandoff()
    }

    /// POSTs the handoff for the current target. Late results of an abandoned handoff are
    /// dropped by comparing the machine's generation.
    private func requestHandoff() {
        guard let handoff = handoff, let bearer = session.token else {
            Self.log.error("A web-session handoff was requested with no handoff pending or no signed-in session; abandoning it.")
            abandonWebSession()
            return
        }
        let generation = webSession.generation
        let next = WebSessionHandoff.nextPath(for: handoff.target)
        handoffTask?.cancel()
        handoffTask = Task { [weak self, client = handoffClient] in
            do {
                let redeemURL = try await client.redeemURL(next: next, bearer: bearer)
                self?.handoffGranted(redeemURL, generation: generation)
            } catch is CancellationError {
                return
            } catch let error as WebSessionHandoffError {
                self?.handoffFailed(error, generation: generation)
            } catch {
                self?.handoffFailed(.unavailable(detail: "unexpected \(type(of: error))"), generation: generation)
            }
        }
    }

    private func handoffGranted(_ redeemURL: URL, generation: Int) {
        guard generation == webSession.generation, let handoff = handoff else { return }
        handoff.host.openRedeem(redeemURL, target: handoff.target)
    }

    private func handoffFailed(_ error: WebSessionHandoffError, generation: Int) {
        guard generation == webSession.generation else { return }
        Self.log.error("Web-session handoff failed: \(error.errorDescription ?? "unknown", privacy: .public)")
        apply(webSession.handoffRequestFailed(error))
    }

    /// WebShellModel.onRedeemOutcome: the redeem navigation ended in `model`.
    private func redeemFinished(on model: WebShellModel, _ outcome: RedeemOutcome) {
        guard let handoff = handoff, handoff.host === model else { return }
        switch outcome {
        case .landed:
            guard webSession.redeemLanded() else { return }
            webSessionEstablished(handoff)
        case .expired:
            Self.log.error("The web-session redeem answered handoff_expired.")
            apply(webSession.redeemExpired())
        case .failed(let message):
            Self.log.error("The web-session redeem navigation failed.")
            apply(webSession.redeemNavigationFailed(message))
        }
    }

    /// The cookie is set: finish the host's page, load what was held, refresh the other shells.
    private func webSessionEstablished(_ finished: Handoff) {
        handoff = nil
        handoffTask = nil
        // The redeem went to "/" when the wanted page is outside the server's allowlist: go there now.
        if WebSessionHandoff.exactNextPath(for: finished.target) == nil {
            finished.host.openNow(finished.target)
        }
        let held = heldLoads
        heldLoads = [:]
        for entry in held.values {
            entry.model.openNow(entry.url)
        }
        for model in allModels where model !== finished.host && held[ObjectIdentifier(model)] == nil {
            model.reloadForWebSession()
        }
    }

    private func apply(_ action: WebSessionMachine.Action) {
        switch action {
        case .none:
            break
        case .requestHandoff:
            requestHandoff()
        case .endNativeSession:
            // A 401: the bearer is dead. Clearing it fires CaramelApp's session-change reset
            // (web data wiped, fresh web views); then the shopper signs in again.
            abandonWebSession()
            session.endSessionRejectedByServer()
            isChoosingSignInProvider = true
        case .showNativeSignIn:
            failPendingLoads { $0.showSignInNeeded() }
            isChoosingSignInProvider = true
        case .showError(let message):
            failPendingLoads { $0.showFailure(message) }
        }
    }

    /// Ends the handoff and shows its failure on the host and on every shell that was waiting.
    private func failPendingLoads(_ show: (WebShellModel) -> Void) {
        var failed = heldLoads.values.map { $0.model }
        if let host = handoff?.host, !failed.contains(where: { $0 === host }) {
            failed.append(host)
        }
        handoff = nil
        handoffTask = nil
        heldLoads = [:]
        for model in failed {
            show(model)
        }
    }

    /// No web session and nothing pending: sign-out, account deletion, a web state wipe,
    /// or a new sign-in that starts over.
    private func abandonWebSession() {
        webSession.reset()
        handoffTask?.cancel()
        handoffTask = nil
        handoff = nil
        heldLoads = [:]
    }
}
