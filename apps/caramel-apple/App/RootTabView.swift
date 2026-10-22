import SwiftUI

/// The container app shell: five tabs. State objects (session, saved stores,
/// extension status) are created once in CaramelApp and injected.
struct RootTabView: View {
    var body: some View {
        TabView {
            OnboardingView()
                .tabItem { Label("Get started", systemImage: "checkmark.seal") }
            DealsView()
                .tabItem { Label("Deals", systemImage: "tag") }
            SearchView()
                .tabItem { Label("Search", systemImage: "magnifyingglass") }
            SavedView()
                .tabItem { Label("Saved", systemImage: "heart") }
            AccountView()
                .tabItem { Label("Account", systemImage: "person.crop.circle") }
        }
        .tint(.orange)
    }
}
