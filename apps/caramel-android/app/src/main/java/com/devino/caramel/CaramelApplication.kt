package com.devino.caramel

import android.app.Application
import com.devino.caramel.core.CaramelApi
import com.devino.caramel.core.KeystoreTokenStore
import com.devino.caramel.core.SessionStore
import com.devino.caramel.web.WebSessionHandoff
import com.devino.caramel.web.WebSessionHandoffClient

/** The app-wide objects, created once. */
class AppContainer(application: Application) {
    val api = CaramelApi()
    val session = SessionStore(api, KeystoreTokenStore(application))

    /** Hands the native sign-in to the WebView as a grabcaramel.com web session (T-7852). */
    val webSession = WebSessionHandoff(WebSessionHandoffClient(api), session)

    /**
     * Whether the WebView holds a web session that mirrors the native sign-in. While false, a web
     * navigation to /login cannot mean "the shopper signed out on the web", so the shell never clears
     * the native token on it (see ShellRoutes.authAction).
     */
    val webSessionActive: Boolean get() = webSession.active
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
