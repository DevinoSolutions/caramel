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
///  - no new web views: window.open and target=_blank go through the same decision.
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
        case failed(String)
    }

    @Published private(set) var pageState: PageState = .idle
    /// A non-fatal problem (e.g. Safari could not be opened). Shown as a dismissible banner.
    @Published var notice: String?

    let webView: WKWebView

    /// Set by ShellRouter: a /login or /signup navigation asks the app to run the native sign-in.
    var onSignInRequested: () -> Void = {}

    private static let log = Logger(subsystem: "com.devino.Caramel", category: "web-shell")

    private let home: URL
    private var lastRequestedURL: URL?
    private var didStartLoading = false

    init(home: URL) {
        self.home = home
        let configuration = WKWebViewConfiguration()
        configuration.applicationNameForUserAgent = ShellUserAgent.applicationName(version: Self.marketingVersion())
        configuration.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        let refresh = UIRefreshControl()
        refresh.addTarget(self, action: #selector(pullToRefresh), for: .valueChanged)
        webView.scrollView.refreshControl = refresh
#if DEBUG
        webView.isInspectable = true
#endif
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

    private func perform(_ decision: AppLinkGuard.Decision) {
        switch decision {
        case .loadInShell(let url):
            open(url)
        case .allowEmbedded:
            // Unreachable for a main-frame decision; refuse rather than guess.
            Self.log.error("An embedded-frame decision reached the main-frame path.")
        case .signIn:
            onSignInRequested()
        case .openInBrowser(let url), .openInSystem(let url):
            openExternally(url)
        case .cancel(let reason):
            Self.log.error("Refused a navigation: \(reason, privacy: .public)")
        }
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
        switch AppLinkGuard.decision(for: url, isMainFrame: isMainFrame) {
        case .loadInShell(let allowed):
            lastRequestedURL = allowed
            decisionHandler(.allow)
        case .allowEmbedded:
            decisionHandler(.allow)
        case .signIn:
            decisionHandler(.cancel)
            onSignInRequested()
        case .openInBrowser(let external), .openInSystem(let external):
            decisionHandler(.cancel)
            openExternally(external)
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
        perform(AppLinkGuard.decision(for: url, isMainFrame: true))
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
