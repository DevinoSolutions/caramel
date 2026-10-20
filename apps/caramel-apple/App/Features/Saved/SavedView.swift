import SwiftUI

/// Saved stores plus the local new-codes alerts toggle (AlertsEngine).
struct SavedView: View {
    @EnvironmentObject private var favorites: FavoritesStore

    @State private var newCodes: [String: Int] = [:]
    @State private var alertsOn = AlertsEngine.notifyEnabled
    @State private var alertsMessage: String?

    var body: some View {
        NavigationStack {
            List {
                if let message = favorites.errorMessage {
                    Section { ErrorBanner(message: message, retryTitle: "Dismiss") { favorites.errorMessage = nil } }
                }
                if favorites.stores.isEmpty {
                    Section {
                        VStack(spacing: 8) {
                            Image(systemName: "heart").font(.largeTitle).foregroundStyle(.secondary)
                            Text("No saved stores yet").font(.headline)
                            Text("Tap the heart on a store's page to keep it here.")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.center)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 24)
                    }
                } else {
                    Section {
                        ForEach(favorites.stores, id: \.self) { store in
                            NavigationLink(value: store) {
                                StoreRow(domain: store, newCodes: newCodes[store] ?? 0)
                            }
                        }
                        .onDelete { offsets in Task { await favorites.remove(at: offsets) } }
                    } footer: {
                        Text(favorites.isSyncedToAccount
                            ? "Synced to your Caramel account."
                            : "Saved on this device. Sign in from the Account tab to keep them across devices.")
                    }
                }
                Section {
                    Toggle("Notify me about new codes", isOn: alertsBinding)
                    if let alertsMessage = alertsMessage {
                        Text(alertsMessage).font(.footnote).foregroundStyle(.red)
                    }
                } header: {
                    Text("Alerts")
                } footer: {
                    Text("Checked on this device only. iOS decides when Caramel can check in the background, so a notification can arrive late.")
                }
            }
            .navigationTitle("Saved")
            .navigationDestination(for: String.self) { StoreDetailView(domain: $0) }
            .task(id: favorites.stores) { await checkForNewCodes() }
            .refreshable { await checkForNewCodes() }
        }
    }

    private var alertsBinding: Binding<Bool> {
        Binding(
            get: { alertsOn },
            set: { wantsOn in Task { await setAlerts(wantsOn) } }
        )
    }

    private func setAlerts(_ wantsOn: Bool) async {
        alertsMessage = nil
        guard wantsOn else {
            AlertsEngine.notifyEnabled = false
            alertsOn = false
            return
        }
        do {
            let granted = try await AlertsEngine.requestNotificationAuthorization()
            guard granted else {
                alertsMessage = "Notifications are off for Caramel. Turn them on in Settings > Notifications > Caramel."
                alertsOn = false
                return
            }
            AlertsEngine.notifyEnabled = true
            alertsOn = true
            AlertsEngine.scheduleNextRefresh()
        } catch {
            alertsMessage = error.localizedDescription
            alertsOn = false
        }
    }

    private func checkForNewCodes() async {
        let result = await AlertsEngine.check(stores: favorites.stores)
        newCodes = Dictionary(uniqueKeysWithValues: result.hits.map { ($0.store, $0.newCodes) })
        if !result.failures.isEmpty {
            alertsMessage = "Could not check some stores:\n" + result.failures
                .map { "\($0.key): \($0.value)" }
                .sorted()
                .joined(separator: "\n")
        }
    }
}
