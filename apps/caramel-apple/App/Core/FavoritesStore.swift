import SwiftUI

/// Saved stores. Signed out they are a local list in the App Group defaults;
/// signed in the account's /api/account/favorites list is the truth and the
/// local list is just its mirror (so the background alerts check can read it
/// without a network round trip).
@MainActor
final class FavoritesStore: ObservableObject {
    @Published private(set) var stores: [String]
    @Published var errorMessage: String?

    private let api = CaramelAPI.shared
    private let session: SessionStore

    init(session: SessionStore) {
        self.session = session
        self.stores = AppGroup.defaults.stringArray(forKey: AppGroup.Key.savedStores) ?? []
    }

    var isSyncedToAccount: Bool { session.isSignedIn }

    func contains(_ domain: String) -> Bool {
        stores.contains(Self.key(domain))
    }

    /// Reads the account list when signed in (a failure is shown, the cached list stays).
    func refresh() async {
        guard let token = session.token else { return }
        do {
            replace(with: try await api.favorites(bearer: token))
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func toggle(_ domain: String) async {
        await set(domain, favorited: !contains(domain))
    }

    func remove(at offsets: IndexSet) async {
        let doomed = offsets.map { stores[$0] }
        for domain in doomed {
            await set(domain, favorited: false)
        }
    }

    /// Called when the session changes: a new sign-in pushes the device list up
    /// then adopts the account list; a sign-out drops the account's list from
    /// the device.
    func sessionChanged() async {
        guard let token = session.token else {
            replace(with: [])
            return
        }
        var failures: [String] = []
        for domain in stores {
            do {
                _ = try await api.setFavorite(domain, favorited: true, bearer: token)
            } catch {
                failures.append("\(domain): \(error.localizedDescription)")
            }
        }
        if !failures.isEmpty {
            errorMessage = "Could not move some saved stores to your account:\n" + failures.joined(separator: "\n")
        }
        await refresh()
    }

    private func set(_ domain: String, favorited: Bool) async {
        let key = Self.key(domain)
        guard let token = session.token else {
            replace(with: favorited ? [key] + stores.filter { $0 != key } : stores.filter { $0 != key })
            return
        }
        do {
            let stored = try await api.setFavorite(key, favorited: favorited, bearer: token)
            replace(with: favorited ? [stored] + stores.filter { $0 != stored } : stores.filter { $0 != stored && $0 != key })
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func replace(with newStores: [String]) {
        stores = newStores
        AppGroup.defaults.set(newStores, forKey: AppGroup.Key.savedStores)
    }

    private static func key(_ domain: String) -> String {
        domain.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}
