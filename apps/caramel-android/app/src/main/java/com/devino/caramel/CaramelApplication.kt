package com.devino.caramel

import android.app.Application
import com.devino.caramel.core.CaramelApi
import com.devino.caramel.core.FavoritesStore
import com.devino.caramel.core.KeystoreTokenStore
import com.devino.caramel.core.PrefsListStore
import com.devino.caramel.core.SessionStore

/** The app-wide objects, created once (the iOS app creates the same three in CaramelApp.swift). */
class AppContainer(application: Application) {
    val api = CaramelApi()
    val session = SessionStore(api, KeystoreTokenStore(application))
    val favorites = FavoritesStore(api, PrefsListStore(application)) { session.token }
}

class CaramelApplication : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }
}
