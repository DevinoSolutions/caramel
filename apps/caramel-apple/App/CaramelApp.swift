import SwiftUI

@main
struct CaramelApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var session: SessionStore
    @StateObject private var favorites: FavoritesStore
    @StateObject private var extensionStatus = ExtensionStatus()
    @StateObject private var router = ShellRouter()

    init() {
        ScreenshotLaunch.seedSavedStoresIfRequested() // App Store screenshot capture only; inert without its launch argument
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
                .environmentObject(router)
                .onOpenURL { router.handleIncoming($0) }
                .task {
                    // Launch: confirm the stored sign-in is alive, then adopt the account's saved stores.
                    await session.validate()
                    await favorites.refresh()
                }
                .onChange(of: session.token) { _ in
                    Task { await favorites.sessionChanged() }
                    // Every way the session ends (sign-out, account deletion, a 401 expiry in
                    // validate()/deleteAccount()) wipes the web data; AccountView no longer does it itself.
                    if session.token == nil {
                        Task { await router.resetWebState() }
                    }
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
