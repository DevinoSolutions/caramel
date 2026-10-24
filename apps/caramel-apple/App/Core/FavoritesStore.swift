import SwiftUI

/// The on-device mirror of the saved stores that AlertsEngine watches. Signed in,
/// the account's /api/account/favorites list is the truth plus any store still
/// waiting to be pushed up, and the local list mirrors that union (so the
/// background alerts check can read it without a network round trip).
///
/// Saving a store is the web page's job now (the Saved tab frames grabcaramel.com),
/// so nothing in the app adds to the list any more. What remains is the sync, and
/// it still carries stores that earlier versions saved on this device: those are
/// never dropped, they stay in the persisted "pending push" set until the server
/// has confirmed them.
///
/// TODO(T-7852): signed-out shell pages cannot save stores until the web-session
/// handoff exists, so alerts only see stores from a signed-in account.
@MainActor
final class FavoritesStore: ObservableObject {
    @Published private(set) var stores: [String]
    @Published var errorMessage: String?

    /// TODO(T-4905): the server allows 30 mutations/min per account. One sync
    /// pushes at most this many stores (sequentially, stopping on HTTP 429); the
    /// rest stay pending and go up on the next sync (app open or Account refresh).
    /// A bulk endpoint (T-4906) would remove the cap.
    private static let maxPushesPerSync = 25

    private let api = CaramelAPI.shared
    private let session: SessionStore

    init(session: SessionStore) {
        self.session = session
        self.stores = AppGroup.defaults.stringArray(forKey: AppGroup.Key.savedStores) ?? []
    }

    var isSyncedToAccount: Bool { session.isSignedIn }

    /// Signed in: retries any pending pushes, then adopts the account list plus
    /// whatever could not be pushed (a failure is shown, the cached list stays).
    func refresh() async {
        guard let token = session.token else { return }
        await sync(token: token)
    }

    /// Called when the session changes: a new sign-in queues the device list for
    /// push and merges it with the account list; a sign-out drops the account's
    /// list (and the queue) from the device.
    func sessionChanged() async {
        guard let token = session.token else {
            setPending([])
            replace(with: [])
            return
        }
        setPending(Set(pending()).union(stores).sorted())
        await sync(token: token)
    }

    // MARK: Sync

    private func sync(token: String) async {
        let serverStores: [String]
        do {
            serverStores = try await api.favorites(bearer: token)
        } catch is CancellationError {
            return
        } catch {
            // Nothing is dropped: the cached list and the pending queue stay as they were.
            errorMessage = error.localizedDescription
            return
        }

        var pushedKeys: [String] = []
        let serverSet = Set(serverStores)
        var stillPending = pending().filter { !serverSet.contains($0) }
        var failures: [String] = []
        var pushed = 0
        var stoppedOnRateLimit = false

        for domain in stillPending {
            if pushed >= Self.maxPushesPerSync { break }
            do {
                let stored = try await api.setFavorite(domain, favorited: true, bearer: token)
                pushed += 1
                pushedKeys.append(stored)
                stillPending.removeAll { $0 == domain || $0 == stored }
            } catch is CancellationError {
                break
            } catch let error as APIError where error.status == 429 {
                stoppedOnRateLimit = true
                break
            } catch {
                pushed += 1
                failures.append("\(domain): \(error.localizedDescription)")
            }
        }

        setPending(stillPending)
        // Server list first (its order), then what was just pushed, then what is still waiting.
        replace(with: Self.unique(serverStores + pushedKeys + stillPending))

        if stoppedOnRateLimit {
            errorMessage = "Too many changes at once. \(stillPending.count) saved \(stillPending.count == 1 ? "store" : "stores") will sync to your account the next time the app refreshes."
        } else if !failures.isEmpty {
            errorMessage = "Could not move some saved stores to your account:\n" + failures.joined(separator: "\n")
        } else if !stillPending.isEmpty {
            errorMessage = "\(stillPending.count) saved \(stillPending.count == 1 ? "store" : "stores") will sync to your account the next time the app refreshes."
        }
    }

    // MARK: Persistence

    private func pending() -> [String] {
        AppGroup.defaults.stringArray(forKey: AppGroup.Key.savedStoresPendingPush) ?? []
    }

    private func setPending(_ domains: [String]) {
        AppGroup.defaults.set(domains, forKey: AppGroup.Key.savedStoresPendingPush)
    }

    private func replace(with newStores: [String]) {
        stores = newStores
        AppGroup.defaults.set(newStores, forKey: AppGroup.Key.savedStores)
    }

    private static func unique(_ domains: [String]) -> [String] {
        var seen = Set<String>()
        return domains.filter { seen.insert($0).inserted }
    }
}
