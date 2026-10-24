import SwiftUI

enum RootTab: String {
    case onboarding, deals, search, saved, account
}

/// The container app shell: five tabs. State objects (session, saved stores,
/// extension status) are created once in CaramelApp and injected.
struct RootTabView: View {
    // The launch argument only exists for App Store screenshot capture (ScreenshotLaunch).
    @State private var selection: RootTab = ScreenshotLaunch.initialTab ?? .onboarding

    var body: some View {
        TabView(selection: $selection) {
            OnboardingView()
                .tabItem { Label("Get started", systemImage: "checkmark.seal") }
                .tag(RootTab.onboarding)
            DealsView()
                .tabItem { Label("Deals", systemImage: "tag") }
                .tag(RootTab.deals)
            SearchView()
                .tabItem { Label("Search", systemImage: "magnifyingglass") }
                .tag(RootTab.search)
            SavedView()
                .tabItem { Label("Saved", systemImage: "heart") }
                .tag(RootTab.saved)
            AccountView()
                .tabItem { Label("Account", systemImage: "person.crop.circle") }
                .tag(RootTab.account)
        }
        .tint(.orange)
    }
}
