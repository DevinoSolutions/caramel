import Combine
import OSLog
import SwiftUI
import UIKit
import WebKit

/// One framed grabcaramel.com page: owns the WKWebView, its navigation policy and
/// its load state. Every navigation, new-window request and incoming URL is
/// decided by AppLinkGuard; nothing is loaded that it refused.
///
/// Every sign-in, web-session and redeem decision is SignInLoopCoordinator's (ShellConfig.swift,
/// unit tested): this class feeds it the web view's events and carries out the effects it returns
/// (`run`), and decides nothing about them itself.
///
/// What the web view is NOT given, on purpose:
///  - no WKScriptMessageHandler / user script: there is no JS-to-native bridge;
///  - no file-URL access: the guard refuses file: URLs, nothing calls loadFileURL
///    and the private allowFileAccessFromFileURLs preference is left at its default (off);
///  - no new web views: window.open and target=_blank go through the same decision;
///  - no script-launched windows (javaScriptCanOpenWindowsAutomatically is off) and no
///    script-launched Safari/Mail/dialer: an external open needs a tap or a form submit.
///
/// TODO(T-7842): `WKWebViewConfiguration.limitsNavigationsToAppBoundDomains` is not
/// turned on. It needs WKAppBoundDomains (grabcaramel.com, plus the www host if the
/// site serves it) in Info.plist and it restricts which frames can load, so it has
/// to be checked against the live site on a device before it ships.
///
/// TODO(T-7842): WKUIDelegate's JavaScript alert/confirm/prompt panels are not
/// implemented (WebKit then suppresses them). The site uses none today; add them
/// the day it does.
@MainActor
final class WebShellModel: NSObject, ObservableObject {
    enum PageState: Equatable {
        case idle
        case loading
        case loaded
        /// The page wants a signed-in web session and the shopper has none (not signed in, or the handoff could not make one).
        case needsSignIn
        case failed(String)
    }

    @Published private(set) var pageState: PageState = .idle
    /// A non-fatal problem (e.g. Safari could not be opened). Shown as a dismissible banner.
    @Published var notice: String?

    /// Replaced (not reused) by resetToHome so no back-forward list or page cache survives a sign-out.
    @Published private(set) var webView: WKWebView

    /// Set by ShellRouter: pop the native "Apple or Google?" sign-in prompt.
    var onSignInRequested: () -> Void = {}

    /// Set by ShellRouter: the web-session state this tab's loads and sign-in requests are decided against.
    var webSessionContext: () -> WebSessionContext = { .signedOut }

    /// Set by ShellRouter: queue this load until the handoff in flight has made the web session
    /// (it then loads through `openNow`).
    var onHoldForWebSession: (WebShellModel, URL) -> Void = { _, _ in }

    /// Set by ShellRouter: start a web-session handoff hosted by this shell, ending on the URL.
    var onStartHandoff: (WebShellModel, URL) -> Void = { _, _ in }

    /// Set by ShellRouter: how redeem `attempt` (the id passed to `openRedeem`) ended.
    var onRedeemOutcome: (WebShellModel, Int, RedeemOutcome) -> Void = { _, _, _ in }

    /// Set by ShellRouter: the loop cap just parked this tab on "sign in" (T-10055); a handoff it
    /// hosts and any load held for it must be dropped.
    var onParked: (WebShellModel) -> Void = { _ in }

    /// The page this shell shows or is about to show (what a handoff should land on).
    var targetURL: URL { lastRequestedURL ?? home }

    private static let log = Logger(subsystem: "com.devino.Caramel", category: "web-shell")

    private let home: URL
    private var urlObservation: AnyCancellable?
    private var lastObservedURL: URL?
    private var lastRequestedURL: URL?
    private var didStartLoading = false
    /// Never recreated: its loop cap and parked latch must outlive resetToHome (T-10055).
    private var coordinator = SignInLoopCoordinator()
    /// The redeem's WKNavigation and the tab's current main-frame one, kept alive so their
    /// ObjectIdentifiers (what the coordinator matches navigation outcomes against) cannot be reused
    /// by a later navigation.
    private var redeemNavigation: WKNavigation?
    private var currentNavigation: WKNavigation?

    init(home: URL) {
        self.home = home
        webView = Self.makeWebView()
        super.init()
        attach(webView)
    }

    private static func makeWebView() -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.applicationNameForUserAgent = ShellUserAgent.applicationName(version: marketingVersion(), build: buildNumber())
        configuration.websiteDataStore = .default()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        return WKWebView(frame: .zero, configuration: configuration)
    }

    /// Wires delegates, gestures and the URL observation onto `view` (the first one and every replacement).
    private func attach(_ view: WKWebView) {
        view.navigationDelegate = self
        view.uiDelegate = self
        view.allowsBackForwardNavigationGestures = true
        let refresh = UIRefreshControl()
        refresh.addTarget(self, action: #selector(pullToRefresh), for: .valueChanged)
        view.scrollView.refreshControl = refresh
#if DEBUG
        view.isInspectable = true
#endif
        // Client-side routing (history.pushState / router.push) never reaches
        // decidePolicyFor, so the shell also reacts to the URL itself changing.
        urlObservation = view.publisher(for: \.url)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] url in
                Task { @MainActor in self?.urlChanged(url) }
            }
    }

    private static func marketingVersion() -> String {
        guard let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String, !version.isEmpty else {
            preconditionFailure("CFBundleShortVersionString is missing from the app's Info.plist; the CaramelApp user agent cannot be built.")
        }
        return version
    }

    private static func buildNumber() -> String {
        guard let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String, !build.isEmpty else {
            preconditionFailure("CFBundleVersion is missing from the app's Info.plist; the CaramelBuild user agent token cannot be built.")
        }
        return build
    }

    // MARK: Loading

    /// First appearance: load the home page unless something (an incoming link,
    /// a screenshot launch) already loaded another one.
    func loadHomeIfNeeded() {
        guard !didStartLoading else { return }
        open(home)
    }

    /// Loads an AppLinkGuard-approved URL. The guard runs again in decidePolicyFor.
    /// While the shopper is signed in natively but the web view has no web session, the
    /// router holds the load until the handoff (T-7852) has made one.
    func open(_ url: URL) {
        noteRequested(url)
        run(coordinator.pageLoadRequested(url, webSession: webSessionContext(), at: Date()))
    }

    /// `open` once the web session exists: for the router's own loads.
    func openNow(_ url: URL) {
        noteRequested(url)
        run(coordinator.webSessionLoad(url))
    }

    /// Loads the one-time redeem URL (vetted by WebSessionHandoffClient) for redeem `attempt` through
    /// the same guarded path as every other navigation; its 303 sets the session cookie in this
    /// web view's data store and lands on `target`. The redeem URL is never remembered as
    /// the page to retry: it is single use. False when the tab is parked on "sign in" (nothing loads).
    func openRedeem(_ redeemURL: URL, target: URL, attempt: Int) -> Bool {
        guard coordinator.beginRedeem(redeemURL, attempt: attempt) else { return false }
        noteRequested(target)
        pageState = .loading
        redeemNavigation = webView.load(URLRequest(url: redeemURL))
        run(coordinator.redeemLoadIssued(attempt: attempt, navigation: Self.identity(of: redeemNavigation)))
        return true
    }

    /// A web session now exists (another shell's redeem set the cookie): show this shell's page signed in.
    func reloadForWebSession() {
        run(coordinator.webSessionEstablishedElsewhere(
            target: targetURL,
            hasStartedLoading: didStartLoading,
            hasPage: webView.url != nil,
            showsSignInScreen: pageState == .needsSignIn
        ))
    }

    /// The web session could not be made; the page shows `message` with a retry.
    func showFailure(_ message: String) {
        run(coordinator.webSessionFailed(message))
    }

    /// The page needs a web session the app could not make; the shopper is offered native sign-in.
    func showSignInNeeded() {
        pageState = .needsSignIn
    }

    /// Stops whatever this shell is loading, a redeem included, so it cannot set a cookie after a wipe.
    func stopLoading() {
        run(coordinator.stopLoading())
    }

    /// Back to the guarded home page (after sign-out or account deletion, once the web data is cleared).
    /// Discards the WKWebView for a fresh one: reloading the old one would keep its
    /// back-forward list (and WebKit's page cache), so the next person on the device
    /// could swipe back to a signed-in page. Android's resetWebSession does the same.
    func resetToHome() {
        let old = webView
        old.stopLoading()
        // Take the old view off screen BEFORE dropping its delegates: a web view with no
        // navigation delegate lets WebKit allow every navigation, so it must never stay visible.
        old.scrollView.refreshControl = nil
        old.removeFromSuperview()
        old.navigationDelegate = nil
        old.uiDelegate = nil
        urlObservation = nil
        lastObservedURL = nil
        lastRequestedURL = nil
        redeemNavigation = nil
        currentNavigation = nil
        coordinator.resetToHome()
        // A parked tab stays on "sign in" across the reset (T-10055).
        pageState = coordinator.isParked ? .needsSignIn : .idle
        // Not started: the visible tab's .task (loadHomeIfNeeded) loads home. Loading all four
        // shells eagerly would let a signed-out /profile redirect to /login and pop the native sign-in.
        didStartLoading = false
        webView = Self.makeWebView()
        attach(webView)
    }

    /// The shopper tapped "Try again" (or pulled to refresh an empty tab).
    func retry() {
        let url = lastRequestedURL ?? home
        noteRequested(url)
        run(coordinator.userTappedTryAgain(url, webSession: webSessionContext(), at: Date()))
    }

    /// The shopper tapped "Sign in" on the sign-in screen.
    func signInTapped() {
        run(coordinator.userTappedSignIn())
    }

    @objc private func pullToRefresh() {
        if webView.url == nil {
            retry()
        } else {
            webView.reload()
        }
    }

    private func noteRequested(_ url: URL) {
        didStartLoading = true
        lastRequestedURL = url
    }

    // MARK: Effects

    /// Carries out what SignInLoopCoordinator decided, in order.
    private func run(_ effects: [SignInLoopEffect]) {
        for effect in effects {
            switch effect {
            case .load(let url):
                webView.load(URLRequest(url: url))
            case .reload:
                webView.reload()
            case .stepBack:
                webView.goBack()
            case .stopLoading:
                webView.stopLoading()
            case .holdForWebSession(let url):
                pageState = .loading
                onHoldForWebSession(self, url)
            case .startHandoff(let url):
                pageState = .loading
                onStartHandoff(self, url)
            case .showNativeSignIn:
                onSignInRequested()
            case .showLoading:
                pageState = .loading
            case .showLoaded:
                pageState = .loaded
            case .showSignInScreen:
                pageState = .needsSignIn
            case .showFailure(let message):
                pageState = .failed(message)
            case .readSessionCookie(let attempt):
                readSessionCookie(for: attempt)
            case .settleRedeem(let attempt, let outcome):
                onRedeemOutcome(self, attempt, outcome)
            case .parked:
                reportParked()
                onParked(self)
            case .logError(let message):
                Self.log.error("\(message, privacy: .public)")
            }
        }
    }

    /// The cookie is read from this web view's own data store (the one the router wipes on a token
    /// change), so a landing on an allowlisted page only counts when the signed session cookie is
    /// really there. The coordinator drops a read whose attempt is no longer current.
    private func readSessionCookie(for attempt: Int) {
        webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
            Task { @MainActor in
                guard let self = self else { return }
                self.run(self.coordinator.cookieReadFinished(attempt: attempt, hasSessionCookie: WebSessionHandoff.hasSessionCookie(cookies)))
            }
        }
    }

    /// TODO(T-10055): sentry-cocoa is not linked into the app target (AlertsEngine carries the same
    /// TODO(T-4905)), so a park reaches only the unified log. Once Sentry is linked, add ONE breadcrumb
    /// and ONE captureMessage here (this runs once per park), tagged with the page and CFBundleVersion.
    private func reportParked() {
        let page = (webView.url ?? lastRequestedURL)?.path ?? "unknown"
        Self.log.fault("Sign-in loop stopped: more than \(SignInLoopCoordinator.maxAutomaticRequests) automatic sign-in requests in \(Int(SignInLoopCoordinator.window)) s on this tab (page \(page, privacy: .public)); parked on sign-in until the shopper taps.")
    }

    private static func identity(of navigation: WKNavigation?) -> ObjectIdentifier? {
        navigation.map { ObjectIdentifier($0) }
    }

    // MARK: Decisions

    private func urlChanged(_ url: URL?) {
        guard let url = url, url != lastObservedURL else { return }
        lastObservedURL = url
        switch AppLinkGuard.decision(for: url, isMainFrame: true) {
        case .signIn:
            // The web app routed itself to /login (or a signed-out page bounced there):
            // run the native sign-in, and step the page back to where it was.
            pageAskedForSignIn(stepBack: true)
        case .loadInShell:
            if let store = StorePath.store(fromSegments: AppLinkGuard.pathSegments(of: url)) {
                AlertsEngine.noteVisited(store: store)
            }
        case .allowEmbedded, .openInBrowser, .openInSystem, .blockedExternal, .cancel:
            break
        }
    }

    /// A page asked for /login or /signup; SignInLoopCoordinator.automaticSignInRequest decides what that gets.
    private func pageAskedForSignIn(stepBack: Bool) {
        let backURL = webView.backForwardList.backItem?.url
        let bouncedFrom = stepBack ? (backURL ?? lastRequestedURL) : (webView.url ?? lastRequestedURL)
        run(coordinator.automaticSignInRequest(
            stepBack: stepBack,
            bouncedFrom: bouncedFrom,
            backURL: backURL,
            hasPage: webView.url != nil,
            webSession: webSessionContext(),
            at: Date()
        ))
    }

    private static func kind(of type: WKNavigationType) -> AppLinkGuard.NavigationKind {
        switch type {
        case .linkActivated: return .linkActivated
        case .formSubmitted: return .formSubmitted
        default: return .other
        }
    }

    private func perform(_ decision: AppLinkGuard.Decision) {
        switch decision {
        case .loadInShell(let url):
            open(url)
        case .allowEmbedded:
            // Unreachable for a main-frame decision; refuse rather than guess.
            Self.log.error("An embedded-frame decision reached the main-frame path.")
        case .signIn:
            pageAskedForSignIn(stepBack: false)
        case .openInBrowser(let url), .openInSystem(let url):
            openExternally(url)
        case .blockedExternal:
            blockExternalOpen()
        case .cancel(let reason):
            Self.log.error("Refused a navigation: \(reason, privacy: .public)")
        }
    }

    private func blockExternalOpen() {
        Self.log.error("Blocked an external open that no tap asked for.")
        notice = "A page tried to open another app or website without a tap, so Caramel blocked it."
    }

    private func openExternally(_ url: URL) {
        Task {
            if await UIApplication.shared.open(url) { return }
            Self.log.error("The system refused to open a link (scheme \(url.scheme ?? "none", privacy: .public)).")
            notice = "That link could not be opened."
        }
    }

    /// False (logged) for a callback from a web view resetToHome already replaced: its outcomes are not this tab's.
    private func isCurrent(_ view: WKWebView) -> Bool {
        guard view === webView else {
            Self.log.error("Dropped a navigation callback from a replaced web view.")
            return false
        }
        return true
    }

    private func finish(_ navigation: WKNavigation?, with error: Error) {
        webView.scrollView.refreshControl?.endRefreshing()
        let nsError = error as NSError
        // A navigation the policy methods cancelled (or one superseded by a newer request) reports
        // NSURLErrorCancelled: never a failure to show, but it is how a refused redeem redirect ends.
        let cancelled = nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled
        if !cancelled { Self.log.error("Page load failed: \(nsError.domain, privacy: .public) \(nsError.code)") }
        run(coordinator.navigationFailed(Self.identity(of: navigation), domain: nsError.domain, code: nsError.code, description: nsError.localizedDescription, cancelled: cancelled))
    }
}

extension WebShellModel: WKNavigationDelegate {
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            Self.log.error("Refused a navigation without a URL.")
            decisionHandler(.cancel)
            return
        }
        // A navigation with no target frame is treated as main-frame (the stricter policy).
        let isMainFrame = navigationAction.targetFrame?.isMainFrame ?? true
        switch coordinator.navigationPolicy(for: url, isMainFrame: isMainFrame) {
        case .guardDecides:
            break
        case .cancelWhileParked:
            Self.log.error("Cancelled a main-frame navigation: this tab is parked on sign-in until the shopper taps.")
            decisionHandler(.cancel)
            return
        case .refuseUnissuedRedeemURL:
            Self.log.error("Refused a redeem URL that was not issued by the handoff.")
            decisionHandler(.cancel)
            return
        case .cancelSignInDuringRedeem:
            Self.log.error("Refused a sign-in page while the web-session redeem is in flight.")
            decisionHandler(.cancel)
            return
        }
        let kind = Self.kind(of: navigationAction.navigationType)
        switch AppLinkGuard.gate(AppLinkGuard.decision(for: url, isMainFrame: isMainFrame), kind: kind) {
        case .loadInShell(let allowed):
            // The single-use redeem URL is never the page to retry (openRedeem keeps the target).
            if !WebSessionHandoff.isRedeemURL(allowed) {
                lastRequestedURL = allowed
            }
            decisionHandler(.allow)
        case .allowEmbedded:
            decisionHandler(.allow)
        case .signIn:
            decisionHandler(.cancel)
            pageAskedForSignIn(stepBack: false)
        case .openInBrowser(let external), .openInSystem(let external):
            decisionHandler(.cancel)
            openExternally(external)
        case .blockedExternal:
            decisionHandler(.cancel)
            blockExternalOpen()
        case .cancel(let reason):
            Self.log.error("Refused a navigation: \(reason, privacy: .public)")
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        guard isCurrent(webView) else { return }
        currentNavigation = navigation
        run(coordinator.navigationStarted(Self.identity(of: navigation)))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard isCurrent(webView) else { return }
        webView.scrollView.refreshControl?.endRefreshing()
        run(coordinator.navigationFinished(Self.identity(of: navigation), at: webView.url))
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard isCurrent(webView) else { return }
        finish(navigation, with: error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard isCurrent(webView) else { return }
        finish(navigation, with: error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard isCurrent(webView) else { return }
        Self.log.error("The web content process terminated.")
        run(coordinator.webContentTerminated())
    }
}

extension WebShellModel: WKUIDelegate {
    /// target=_blank and window.open: never a second WKWebView. The request gets
    /// the same decision as a main-frame navigation and, when allowed, loads here.
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        guard let url = navigationAction.request.url else {
            Self.log.error("Refused a new-window request without a URL.")
            return nil
        }
        let kind = Self.kind(of: navigationAction.navigationType)
        perform(AppLinkGuard.gate(AppLinkGuard.decision(for: url, isMainFrame: true), kind: kind))
        return nil
    }
}

/// Hosts the model's WKWebView. The web view outlives this wrapper, so a tab keeps
/// its page and back-forward history when SwiftUI rebuilds the view.
private struct WebViewHost: UIViewRepresentable {
    let webView: WKWebView

    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

/// A framed grabcaramel.com page with a visible failure state (no blank screen on error).
struct WebShellView: View {
    @ObservedObject var model: WebShellModel

    var body: some View {
        // .id forces SwiftUI to build a new host (makeUIView) when resetToHome replaces the web view.
        WebViewHost(webView: model.webView)
            .id(ObjectIdentifier(model.webView))
            .overlay(alignment: .top) {
                if model.pageState == .loading {
                    ProgressView().padding(8)
                }
            }
            .overlay {
                if model.pageState == .needsSignIn {
                    VStack(spacing: 12) {
                        Text("Sign in to see this page").font(.headline)
                        Button("Sign in") { model.signInTapped() }
                            .buttonStyle(.borderedProminent)
                        Button("Try again") { model.retry() }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(.background)
                }
            }
            .overlay {
                if case .failed(let message) = model.pageState {
                    ErrorBanner(message: message) { model.retry() }
                        .padding()
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                        .padding()
                }
            }
            .overlay(alignment: .bottom) {
                if let notice = model.notice {
                    ErrorBanner(message: notice, retryTitle: "Dismiss") { model.notice = nil }
                        .padding()
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                        .padding()
                }
            }
            // Keyed on the web view: resetToHome swaps it, which restarts the task and loads
            // the new view. A plain .onAppear does not fire again for a tab that stays on
            // screen, which left a blank tab after a launch-time 401 reset.
            .task(id: ObjectIdentifier(model.webView)) { @MainActor in model.loadHomeIfNeeded() }
    }
}
