import BackgroundTasks
import OSLog
import UserNotifications

/// Alerts v1: LOCAL ONLY. No push, no server state. The app compares each saved
/// store's visible-coupon total against the total the shopper last looked at; a
/// larger total means new codes. The comparison runs when the app opens and
/// from a BGAppRefreshTask, and can raise a local notification.
///
/// TODO(T-4905): limits of v1, all deliberate. iOS decides when (and whether) a
/// background refresh runs, so a notification can lag by hours or never fire on
/// a device with Background App Refresh off. A total can also rise from a
/// re-listed old code, not only a brand-new one. A server-driven alert (push on
/// a new verified code) is the follow-up and needs web work.
enum AlertsEngine {
    private static let log = Logger(subsystem: "com.devino.Caramel", category: "alerts")

    struct Hit: Equatable {
        let store: String
        let newCodes: Int
        /// The store's coupon total at check time: what `markSeen` records once the shopper has been shown the hit.
        let total: Int
    }

    struct CheckResult {
        var hits: [Hit] = []
        /// store -> why its total could not be read. Surfaced, never dropped.
        var failures: [String: String] = [:]
    }

    static var notifyEnabled: Bool {
        get { AppGroup.defaults.bool(forKey: AppGroup.Key.alertsNotifyEnabled) }
        set { AppGroup.defaults.set(newValue, forKey: AppGroup.Key.alertsNotifyEnabled) }
    }

    // MARK: Totals bookkeeping

    private static func totals(_ key: String) -> [String: Int] {
        (AppGroup.defaults.dictionary(forKey: key) as? [String: Int]) ?? [:]
    }

    private static func setTotal(_ total: Int, for store: String, key: String) {
        var current = totals(key)
        current[store] = total
        AppGroup.defaults.set(current, forKey: key)
    }

    /// The shopper was shown a store's codes (the Alerts section's manual check): that total is now "seen".
    static func markSeen(store: String, total: Int) {
        setTotal(total, for: store, key: AppGroup.Key.alertsLastSeenTotals)
        setTotal(total, for: store, key: AppGroup.Key.alertsLastNotifiedTotals)
    }

    // MARK: Check

    /// A saved store's web page was opened in the shell: its codes were looked at,
    /// so the next check takes its total as the new baseline instead of reporting
    /// the difference. No network here; the total is read by the check itself.
    static func noteVisited(store: String) {
        let saved = AppGroup.defaults.stringArray(forKey: AppGroup.Key.savedStores) ?? []
        guard saved.contains(store) else { return }
        var visited = Set(AppGroup.defaults.stringArray(forKey: AppGroup.Key.alertsVisitedStores) ?? [])
        if visited.insert(store).inserted {
            AppGroup.defaults.set(visited.sorted(), forKey: AppGroup.Key.alertsVisitedStores)
        }
    }

    private static func clearVisited(_ store: String) {
        var visited = Set(AppGroup.defaults.stringArray(forKey: AppGroup.Key.alertsVisitedStores) ?? [])
        if visited.remove(store) != nil {
            AppGroup.defaults.set(visited.sorted(), forKey: AppGroup.Key.alertsVisitedStores)
        }
    }

    /// New codes per saved store since the shopper last looked (opened the store's
    /// web page, or was shown the hit). A store never seen before gets its baseline
    /// recorded and reports nothing.
    static func check(stores: [String], api: CaramelAPI = .shared) async -> CheckResult {
        var result = CheckResult()
        let lastSeen = totals(AppGroup.Key.alertsLastSeenTotals)
        let visited = Set(AppGroup.defaults.stringArray(forKey: AppGroup.Key.alertsVisitedStores) ?? [])
        for store in stores {
            do {
                let page = try await api.coupons(site: store, page: 1, limit: 1)
                switch AlertsLogic.outcome(seen: lastSeen[store], total: page.total, visited: visited.contains(store)) {
                case .markSeen(let total):
                    markSeen(store: store, total: total)
                    clearVisited(store)
                case .hit(let newCodes):
                    result.hits.append(Hit(store: store, newCodes: newCodes, total: page.total))
                case .lowerBaseline(let total):
                    markSeen(store: store, total: total)
                case .nothingNew:
                    break
                }
            } catch is CancellationError {
                // The caller went away (view change, new run): the rest of the
                // stores were not checked, which is not a failure to report.
                break
            } catch {
                result.failures[store] = error.localizedDescription
            }
        }
        return result
    }

    // MARK: Notifications

    static func requestNotificationAuthorization() async throws -> Bool {
        try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
    }

    /// One local notification per store, and only once per new total.
    static func notify(_ hits: [Hit]) async throws {
        let notified = totals(AppGroup.Key.alertsLastNotifiedTotals)
        let lastSeen = totals(AppGroup.Key.alertsLastSeenTotals)
        for hit in hits {
            let currentTotal = (lastSeen[hit.store] ?? 0) + hit.newCodes
            if let already = notified[hit.store], already >= currentTotal { continue }
            let content = UNMutableNotificationContent()
            content.title = "New Caramel codes"
            content.body = "\(hit.store) has \(hit.newCodes) new \(hit.newCodes == 1 ? "code" : "codes")."
            let request = UNNotificationRequest(identifier: "alerts-\(hit.store)", content: content, trigger: nil)
            try await UNUserNotificationCenter.current().add(request)
            setTotal(currentTotal, for: hit.store, key: AppGroup.Key.alertsLastNotifiedTotals)
        }
    }

    // MARK: Background refresh

    static func scheduleNextRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: AppConfig.alertsTaskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 6 * 60 * 60)
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            log.error("Could not schedule the alerts refresh: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// The BGAppRefreshTask body. Failures go to the unified log (the app has no
    /// Sentry yet: TODO(T-4905) wire sentry-cocoa so these reach the dashboard).
    static func runBackgroundRefresh() async {
        scheduleNextRefresh()
        guard notifyEnabled else { return }
        let stores = AppGroup.defaults.stringArray(forKey: AppGroup.Key.savedStores) ?? []
        let result = await check(stores: stores)
        for (store, reason) in result.failures {
            log.error("Alerts check failed for \(store, privacy: .public): \(reason, privacy: .public)")
        }
        do {
            try await notify(result.hits)
        } catch {
            log.error("Could not post the alerts notification: \(error.localizedDescription, privacy: .public)")
        }
    }
}
