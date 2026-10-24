import Combine
import OSLog
import SwiftUI
import UIKit
import WebKit

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
        /// The page wants a signed-in web session, which the shell does not have yet (TODO(T-7852)).
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

    private static let log = Logger(subsystem: "com.devino.Caramel", category: "web-shell")

    private let home: URL
    private var urlObservation: AnyCancellable?
    private var lastObservedURL: URL?
    private var lastRequestedURL: URL?
    private var didStartLoading = false

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
        urlObservation = view.publisher(for: .url)
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
    func open(_ url: URL) {
        didStartLoading = true
        lastRequestedURL = url
        webView.load(URLRequest(url: url))
    }

    /// Back to the guarded home page (after sign-out or account deletion, once the web data is cleared).
    /// Discards the WKWebView for a fresh one: reloading the old one would keep its
    /// back-forward list (and WebKit's page cache), so the next person on the device
    /// could swipe back to a signed-in page. Android's resetWebSession does the same.
    func resetToHome() {
        let old = webView
        old.stopLoading()
        old.navigationDelegate = nil
        old.uiDelegate = nil
        urlObservation = nil
        lastObservedURL = nil
        lastRequestedURL = nil
        pageState = .idle
        webView = Self.makeWebView()
        attach(webView)
        open(home)
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

    /// A page asked for /login or /signup. The native sign-in is offered; the web login
    /// page itself is never left on screen. Reloading home would loop for a page that
    /// bounces signed-out visitors to /login, so with nothing to step back to the shell
    /// shows a "sign in" state instead.
    private func pageAskedForSignIn(stepBack: Bool) {
        onSignInRequested()
        if stepBack, webView.canGoBack {
            webView.goBack()
        } else if stepBack || webView.url == nil {
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
        pageState = .failed("\(nsError.localizedDescription) (\(nsError.domain) \(nsError.code))")
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
        let kind = Self.kind(of: navigationAction.navigationType)
        switch AppLinkGuard.gate(AppLinkGuard.decision(for: url, isMainFrame: isMainFrame), kind: kind) {
        case .loadInShell(let allowed):
            lastRequestedURL = allowed
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
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finish(with: error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finish(with: error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        Self.log.error("The web content process terminated.")
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
        WebViewHost(webView: model.webView)
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
            .onAppear { model.loadHomeIfNeeded() }
    }
}
