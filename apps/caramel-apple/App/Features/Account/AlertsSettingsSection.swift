import SwiftUI

/// Deal alerts (AlertsEngine): the opt-in toggle and a manual check. It was the
/// bottom of the native Saved tab; the saved-stores list itself is now the web
/// page, but the alerts still read the on-device mirror FavoritesStore keeps of
/// the account's saved stores.
struct AlertsSettingsSection: View {
    @EnvironmentObject private var favorites: FavoritesStore

    @State private var alertsOn = AlertsEngine.notifyEnabled
    @State private var alertsMessage: String?
    @State private var checkMessage: String?
    @State private var isChecking = false

    var body: some View {
        Section {
            Toggle("Notify me about new codes", isOn: alertsBinding)
            if let alertsMessage = alertsMessage {
                Text(alertsMessage).font(.footnote).foregroundStyle(.red)
            }
            Button {
                Task { await checkNow() }
            } label: {
                Label(isChecking ? "Checking..." : "Check saved stores now", systemImage: "arrow.clockwise")
            }
            .disabled(isChecking || favorites.stores.isEmpty)
            if let checkMessage = checkMessage {
                Text(checkMessage).font(.footnote).foregroundStyle(.secondary)
            }
        } header: {
            Text("Alerts")
        } footer: {
            Text(favorites.isSyncedToAccount
                ? "Watches the stores saved to your Caramel account (\(favorites.stores.count) now). Checked on this device only: iOS decides when Caramel can check in the background, so a notification can arrive late."
                : "Watches your saved stores. Sign in to use the stores you save on grabcaramel.com. Checked on this device only: iOS decides when Caramel can check in the background, so a notification can arrive late.")
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

    private func checkNow() async {
        isChecking = true
        defer { isChecking = false }
        let result = await AlertsEngine.check(stores: favorites.stores)
        // A cancelled check (view change, new run) is incomplete: keep the last message.
        guard !Task.isCancelled else { return }
        var lines: [String] = []
        if result.hits.isEmpty {
            lines.append("No new codes since you last looked.")
        } else {
            // The hits are on screen now, so they count as looked at.
            for hit in result.hits { AlertsEngine.markSeen(store: hit.store, total: hit.total) }
            lines.append(contentsOf: result.hits.map { "\($0.store): \($0.newCodes) new \($0.newCodes == 1 ? "code" : "codes")" })
        }
        lines.append(contentsOf: result.failures.map { "Could not check \($0.key): \($0.value)" }.sorted())
        checkMessage = lines.joined(separator: "\n")
    }
}
