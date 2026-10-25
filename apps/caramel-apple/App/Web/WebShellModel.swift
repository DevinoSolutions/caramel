import Combine
import OSLog
import SwiftUI
import UIKit
import WebKit

/// How the web-session redeem navigation (T-7852) ended, reported by the shell that loaded it.
enum RedeemOutcome: Equatable {
    /// The redeem 303 landed on an allowlisted page: the session cookie is set.
    case landed
    /// The server redirected to `/login?error=handoff_expired` (expired, used or revoked code).
    case expired
    /// The navigation failed or ended somewhere unexpected; the message is safe to show.
    case failed(String)
}

/// One framed grabcaramel.com page: owns the WKWebView, its navigation policy and
/// its load state. Every navigation, new-window request and incoming URL is
/// decided by AppLinkGuard; nothing is loaded that it refused.
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

    /// Set by ShellRouter: a /login or /signup navigation asks the app to run the native sign-in.
    var onSignInRequested: () -> Void = {}

    /// Set by ShellRouter: asked before every ordinary page load. True means the router took
    /// over (it runs the web-session handoff, then loads the page through `openNow`).
    var webSessionGate: (WebShellModel, URL) -> Bool = { _, _ in false }

    /// Set by ShellRouter: how the redeem navigation started by `openRedeem` ended.
    var onRedeemOutcome: (WebShellModel, RedeemOutcome) -> Void = { _, _ in }

    /// Set by ShellRouter: a page that needs a web session bounced to /login. True means the
    /// router is running the handoff for it (native session, no web session yet).
    var webSessionRecovery: (WebShellModel, URL) -> Bool = { _, _ in false }

    /// The page this shell shows or is about to show (what a handoff should land on).
    var targetURL: URL { lastRequestedURL ?? home }

    private static let log = Logger(subsystem: "com.devino.Caramel", category: "web-shell")

    private let home: URL
    private var urlObservation: AnyCancellable?
    private var lastObservedURL: URL?
    private var lastRequestedURL: URL?
    private var didStartLoading = false
    /// True from `openRedeem` until the redeem navigation lands, expires or fails.
    private var redeemInFlight = false
    private var bounceGuard = BounceGuard()
    /// The one redeem URL the router issued: it may load once, and no other redeem URL may load at all.
    private var issuedRedeemURL: URL?

    init(home: URL) {
        self.home = home
        webView = Self.makeWebView()
        super.init()
        attach(webView)
    }

    private static func makeWebView() -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.applicationNameForUserAgent = ShellUserAgent.applicationName(version: marketingVersion())
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
        didStartLoading = true
        lastRequestedURL = url
        if webSessionGate(self, url) {
            pageState = .loading
        } else {
            webView.load(URLRequest(url: url))
        }
    }

    /// `open` without asking the router: for the router's own loads once the web session exists.
    func openNow(_ url: URL) {
        didStartLoading = true
        lastRequestedURL = url
        webView.load(URLRequest(url: url))
    }

    /// Loads the one-time redeem URL (vetted by WebSessionHandoffClient) through the same
    /// guarded path as every other navigation; its 303 sets the session cookie in this
    /// web view's data store and lands on `target`. The redeem URL is never remembered as
    /// the page to retry: it is single use.
    func openRedeem(_ redeemURL: URL, target: URL) {
        didStartLoading = true
        lastRequestedURL = target
        redeemInFlight = true
        issuedRedeemURL = redeemURL
        pageState = .loading
        webView.load(URLRequest(url: redeemURL))
    }

    /// A web session now exists (another shell's redeem set the cookie): show this shell's page signed in.
    func reloadForWebSession() {
        guard didStartLoading else { return }
        if webView.url == nil || pageState == .needsSignIn {
            openNow(targetURL)
        } else {
            webView.reload()
        }
    }

    /// The web session could not be made; the page shows `message` with a retry.
    func showFailure(_ message: String) {
        pageState = .failed(message)
    }

    /// The page needs a web session the app could not make; the shopper is offered native sign-in.
    func showSignInNeeded() {
        pageState = .needsSignIn
    }

    /// Stops whatever this shell is loading, a redeem included, so it cannot set a cookie after a wipe.
    func stopLoading() {
        webView.stopLoading()
        redeemInFlight = false
        issuedRedeemURL = nil
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
        redeemInFlight = false
        issuedRedeemURL = nil
        bounceGuard = BounceGuard()
        pageState = .idle
        // Not started: the visible tab's .task (loadHomeIfNeeded) loads home. Loading all four
        // shells eagerly would let a signed-out /profile redirect to /login and pop the native sign-in.
        didStartLoading = false
        webView = Self.makeWebView()
        attach(webView)
    }

    func retry() {
        open(lastRequestedURL ?? home)
    }

    @objc private func pullToRefresh() {
        if webView.url == nil {
            retry()
        } else {
            webView.reload()
        }
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

    /// A page asked for /login or /signup. The web login page itself is never left on screen.
    ///
    /// Stepping back into a page that bounces signed-out visitors to /login makes it bounce
    /// again at once (CARAMEL-2Y: /profile#favorites to /login in a ~150 ms loop until Safari
    /// refused pushState). So:
    ///  - a page that needs a web session (/profile*) is never stepped back into: with a native
    ///    session the router runs the handoff for it, without one the shell shows "sign in" and stops;
    ///  - any other page is stepped back to only once per back URL and not twice within
    ///    BounceGuard.window, else the shell shows "sign in" and stops.
    private func pageAskedForSignIn(stepBack: Bool) {
        let bouncedFrom = stepBack ? (webView.backForwardList.backItem?.url ?? lastRequestedURL) : (webView.url ?? lastRequestedURL)
        if let page = bouncedFrom, WebSessionHandoff.pageNeedsSession(page) {
            if webSessionRecovery(self, page) {
                // A handoff for that page is under way; it ends on the page itself.
                pageState = .loading
                return
            }
            onSignInRequested()
            pageState = .needsSignIn
            return
        }
        onSignInRequested()
        guard stepBack else {
            if webView.url == nil { pageState = .needsSignIn }
            return
        }
        if bounceGuard.allowsStepBack(at: Date(), backURL: webView.backForwardList.backItem?.url) {
            webView.goBack()
        } else {
            Self.log.error("A page bounced to sign-in again; not stepping back into it.")
            pageState = .needsSignIn
        }
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

    private func finish(with error: Error) {
        webView.scrollView.refreshControl?.endRefreshing()
        let nsError = error as NSError
        // A navigation the policy methods cancelled (or one superseded by a newer
        // request) reports NSURLErrorCancelled; it is not a failure to show.
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
        Self.log.error("Page load failed: \(nsError.domain, privacy: .public) \(nsError.code)")
        if redeemInFlight {
            // Fixed text: the error's own description could quote the one-time redeem URL.
            redeemInFlight = false
            onRedeemOutcome(self, .failed("Could not open your account page (\(nsError.domain) \(nsError.code)). Check your connection and try again."))
            return
        }
        pageState = .failed("\(nsError.localizedDescription) (\(nsError.domain) \(nsError.code))")
    }

    /// The redeem navigation finished: it worked when it ended on a page the handoff `next`
    /// allowlist covers (the 303 sets the cookie before it redirects).
    /// The cookie is read from this web view's own data store (the one the router wipes on a token change), so a
    /// landing on an allowlisted page only counts when the signed session cookie is really there.
    private func settleRedeem(finishedAt url: URL?) {
        redeemInFlight = false
        issuedRedeemURL = nil
        guard let url = url, WebSessionHandoff.isSessionPage(url) else {
            Self.log.error("The web-session redeem ended on an unexpected page.")
            onRedeemOutcome(self, .failed("Your account page did not open as expected. Please try again."))
            return
        }
        let view = webView
        view.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
            Task { @MainActor in
                guard let self = self, self.webView === view else { return }
                if WebSessionHandoff.hasSessionCookie(cookies) {
                    self.onRedeemOutcome(self, .landed)
                } else {
                    Self.log.error("The web-session redeem landed without a session cookie.")
                    self.onRedeemOutcome(self, .failed("Your account page opened without signing in. Please try again."))
                }
            }
        }
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
        // Only the URL the router issued loads, and only once; any other redeem URL is refused.
        if WebSessionHandoff.isRedeemURL(url) {
            guard url == issuedRedeemURL else {
                Self.log.error("Refused a redeem URL that was not issued by the handoff.")
                decisionHandler(.cancel)
                return
            }
            issuedRedeemURL = nil
        }
        // The redeem route answers a dead code with a redirect to /login. While our own redeem is
        // in flight that is the handoff failing, not a page asking the shopper to sign in.
        // A navigation with no target frame is treated as main-frame (the stricter policy).
        let isMainFrame = navigationAction.targetFrame?.isMainFrame ?? true
        switch RedeemNavigation.classify(url, redeemInFlight: redeemInFlight, isMainFrame: isMainFrame) {
        case .expired:
            redeemInFlight = false
            decisionHandler(.cancel)
            onRedeemOutcome(self, .expired)
            return
        case .signInBounce:
            // Any other /login or /signup ends the redeem too; without this the cancel below is
            // swallowed as NSURLErrorCancelled and the shell would wait on the handoff forever.
            redeemInFlight = false
            issuedRedeemURL = nil
            decisionHandler(.cancel)
            onRedeemOutcome(self, .failed("Your account page asked you to sign in again. Please try again."))
            return
        case .proceed:
            break
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
        pageState = .loading
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.scrollView.refreshControl?.endRefreshing()
        pageState = .loaded
        if redeemInFlight {
            settleRedeem(finishedAt: webView.url)
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finish(with: error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finish(with: error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        Self.log.error("The web content process terminated.")
        if redeemInFlight {
            redeemInFlight = false
            onRedeemOutcome(self, .failed("The page stopped unexpectedly. Please try again."))
            return
        }
        pageState = .failed("The page stopped unexpectedly.")
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
                        Button("Sign in") { model.onSignInRequested() }
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
