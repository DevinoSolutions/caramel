package com.devino.caramel

import android.app.Application
import com.devino.caramel.core.CaramelApi
import com.devino.caramel.core.FavoritesStore
import com.devino.caramel.core.KeystoreTokenStore
import com.devino.caramel.core.PrefsListStore
import com.devino.caramel.core.SessionStore

/** The bytes of an account export between "download" and the file picker's answer. */
class PendingExport {
    @Volatile
    var bytes: ByteArray? = null

    /** Returns the held bytes and forgets them. */
    fun take(): ByteArray? = bytes.also { bytes = null }
}

/** The app-wide objects, created once (the iOS app creates the same three in CaramelApp.swift). */
class AppContainer(application: Application) {
    val api = CaramelApi()
    val pendingExport = PendingExport()
    val session = SessionStore(api, KeystoreTokenStore(application))
    val favorites = FavoritesStore(api, PrefsListStore(application)) { session.token }
}

// TODO(T-7474): no crash / error reporting and no trace propagation yet. The repo rule is that
// errors reach Sentry with a request id and that one trace id flows end to end; the iOS app has
// the same gap. Until a Sentry Android SDK (and the sentry-trace / baggage headers on CaramelApi
// requests) is added, a failure is only visible on screen (ApiError carries the x-request-id the
// server logs) and a crash is only visible in Play Console vitals.
class CaramelApplication : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }
}
