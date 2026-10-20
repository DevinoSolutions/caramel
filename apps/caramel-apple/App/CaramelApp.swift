import SwiftUI

@main
struct CaramelApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var session: SessionStore
    @StateObject private var favorites: FavoritesStore
    @StateObject private var extensionStatus = ExtensionStatus()

    init() {
        let session = SessionStore()
        _session = StateObject(wrappedValue: session)
        _favorites = StateObject(wrappedValue: FavoritesStore(session: session))
    }

    var body: some Scene {
        WindowGroup {
            RootTabView()
                .environmentObject(session)
                .environmentObject(favorites)
                .environmentObject(extensionStatus)
                .task {
                    // Launch: confirm the stored sign-in is alive, then adopt the account's saved stores.
                    await session.validate()
                    await favorites.refresh()
                }
                .onChange(of: session.token) { _ in
                    Task { await favorites.sessionChanged() }
                }
                .onChange(of: scenePhase) { phase in
                    switch phase {
                    case .active: extensionStatus.refresh()
                    case .background: AlertsEngine.scheduleNextRefresh()
                    default: break
                    }
                }
        }
        // iOS 16+: runs when iOS grants a background refresh (see AlertsEngine's limits).
        .backgroundTask(.appRefresh(AppConfig.alertsTaskIdentifier)) {
            await AlertsEngine.runBackgroundRefresh()
        }
    }
}
