import SwiftUI

enum RootTab: String {
    case onboarding, deals, search, saved, account
}

/// The container app shell: five tabs. "Get started" (the native Safari-extension
/// walkthrough, App Review guideline 4.2) is first and is the first-launch screen;
/// Deals, Search and Saved frame the grabcaramel.com screens in a WKWebView; Account
/// stays native (sign-in, account deletion, deal alerts, privacy policy).
///
/// State objects (session, saved stores, extension status, router) are created
/// once in CaramelApp and injected.
struct RootTabView: View {
    @EnvironmentObject private var router: ShellRouter
    @EnvironmentObject private var session: SessionStore

    var body: some View {
        // The launch argument behind the initial selection only exists for App Store screenshot capture (ScreenshotLaunch).
        TabView(selection: $router.selection) {
            OnboardingView()
                .tabItem { Label("Get started", systemImage: "checkmark.seal") }
                .tag(RootTab.onboarding)
            webTab(router.deals)
                .tabItem { Label("Deals", systemImage: "tag") }
                .tag(RootTab.deals)
            webTab(router.stores)
                .tabItem { Label("Search", systemImage: "magnifyingglass") }
                .tag(RootTab.search)
            webTab(router.saved)
                .tabItem { Label("Saved", systemImage: "heart") }
                .tag(RootTab.saved)
            AccountView()
                .tabItem { Label("Account", systemImage: "person.crop.circle") }
                .tag(RootTab.account)
        }
        .tint(.orange)
        .confirmationDialog("Sign in to Caramel", isPresented: $router.isChoosingSignInProvider, titleVisibility: .visible) {
            Button("Continue with Apple") { Task { await router.signInFromWeb(.apple, session: session) } }
            Button("Continue with Google") { Task { await router.signInFromWeb(.google, session: session) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Signing in happens in a secure sheet, because Google does not allow sign-in inside an app's web view.")
        }
    }

    private func webTab(_ model: WebShellModel) -> some View {
        VStack(spacing: 0) {
            ExtensionStatusPill { router.selection = .onboarding }
            WebShellView(model: model)
        }
    }
}
