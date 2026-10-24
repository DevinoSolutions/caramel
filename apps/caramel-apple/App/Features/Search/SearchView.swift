import SwiftUI

/// Store search and browse. An empty query lists popular stores.
struct SearchView: View {
    @EnvironmentObject private var favorites: FavoritesStore

    @State private var query = ScreenshotLaunch.searchQuery ?? "" // non-empty only for App Store screenshot capture
    @State private var state: LoadState<[String]> = .idle

    var body: some View {
        NavigationStack {
            List {
                switch state {
                case .idle, .loading:
                    ProgressView()
                case .failed(let message):
                    ErrorBanner(message: message) { Task { await search() } }
                case .loaded(let stores) where stores.isEmpty:
                    Text("No stores match \"\(query)\". Try the store's domain, like nike.com.")
                        .foregroundStyle(.secondary)
                case .loaded(let stores):
                    ForEach(stores, id: \.self) { store in
                        NavigationLink(value: store) {
                            StoreRow(domain: store, isSaved: favorites.contains(store))
                        }
                    }
                }
            }
            .navigationTitle("Search")
            .navigationDestination(for: String.self) { StoreDetailView(domain: $0) }
            .searchable(text: $query, prompt: "Store name or domain")
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
            // Re-runs on every keystroke and cancels the previous run, so the
            // sleep debounces typing.
            .task(id: query) {
                do {
                    try await Task.sleep(nanoseconds: 300_000_000)
                } catch {
                    return // superseded by a newer keystroke
                }
                await search()
            }
        }
    }

    private func search() async {
        state = .loading
        do {
            let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
            state = .loaded(try await CaramelAPI.shared.storeOptions(query: trimmed))
        } catch is CancellationError {
            return
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
