import SwiftUI

@main
struct CaramelApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var session: SessionStore
    @StateObject private var favorites: FavoritesStore
    @StateObject private var extensionStatus = ExtensionStatus()
    @StateObject private var router: ShellRouter

    init() {
        ScreenshotLaunch.seedSavedStoresIfRequested() // App Store screenshot capture only; inert without its launch argument
        let session = SessionStore()
        _session = StateObject(wrappedValue: session)
        _favorites = StateObject(wrappedValue: FavoritesStore(session: session))
        _router = StateObject(wrappedValue: ShellRouter(session: session))
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
                    // Every token change reaches the web views here: the web data is wiped when a token
                    // goes or is replaced (sign-out, deletion, a 401, A to B) and a present token gets
                    // its web session handoff (T-7852). AccountView no longer does any of it itself.
                    router.sessionTokenChanged(to: session.token)
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
