import SwiftUI

/// The container app shell: five tabs, none implemented yet.
/// Every tab is an honest placeholder; no sample data is shown as if real.
struct RootTabView: View {
    var body: some View {
        TabView {
            // TODO(T-4905): Onboarding (3 steps to Safari > Extensions > Caramel > Allow on Every Website).
            PlaceholderTab(title: "Onboarding", systemImage: "checkmark.seal")
                .tabItem { Label("Onboarding", systemImage: "checkmark.seal") }
            // TODO(T-4905): Deals feed (recently-worked codes + top stores from the Caramel API).
            PlaceholderTab(title: "Deals", systemImage: "tag")
                .tabItem { Label("Deals", systemImage: "tag") }
            // TODO(T-4905): Store search/browse with codes and copy-code.
            PlaceholderTab(title: "Search", systemImage: "magnifyingglass")
                .tabItem { Label("Search", systemImage: "magnifyingglass") }
            // TODO(T-4905): Saved stores (favorites API).
            PlaceholderTab(title: "Saved", systemImage: "heart")
                .tabItem { Label("Saved", systemImage: "heart") }
            // TODO(T-4905): Account (sign in via ASWebAuthenticationSession, savings, export/delete).
            PlaceholderTab(title: "Account", systemImage: "person.crop.circle")
                .tabItem { Label("Account", systemImage: "person.crop.circle") }
        }
    }
}

/// Placeholder body for a tab that has no feature behind it yet.
struct PlaceholderTab: View {
    let title: String
    let systemImage: String

    var body: some View {
        NavigationStack {
            VStack(spacing: 12) {
                Image(systemName: systemImage)
                    .font(.system(size: 40))
                    .foregroundStyle(.secondary)
                Text("\(title) is not built yet.")
                    .font(.headline)
                Text("Caramel works in Safari today. Turn it on in Settings > Safari > Extensions.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)
            }
            .navigationTitle(title)
        }
    }
}
