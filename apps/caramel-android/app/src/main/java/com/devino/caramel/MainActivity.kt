package com.devino.caramel

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.browser.customtabs.CustomTabsIntent
import androidx.lifecycle.lifecycleScope
import com.devino.caramel.core.AppConfig
import com.devino.caramel.ui.CaramelApp
import com.devino.caramel.ui.CaramelTheme
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private lateinit var container: AppContainer

    // True from the moment the sign-in tab opens until the callback arrives or the shopper returns.
    private var awaitingBrowser = false
    private var leftForBrowser = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        container = (application as CaramelApplication).container
        // A fresh launch can itself be the sign-in callback (the process was reclaimed while the
        // browser tab was open). A recreation (rotation) must not replay the same callback.
        if (savedInstanceState == null) handleCallback(intent)
        setContent {
            CaramelTheme {
                CaramelApp(container = container, onStartSignIn = ::openSignInTab)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleCallback(intent)
    }

    override fun onStop() {
        super.onStop()
        if (awaitingBrowser) leftForBrowser = true
    }

    override fun onResume() {
        super.onResume()
        if (leftForBrowser) {
            // Back from the browser tab with no callback: the shopper closed it. No error to report.
            leftForBrowser = false
            awaitingBrowser = false
            container.session.abandonSignIn()
        }
    }

    private fun handleCallback(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme != AppConfig.SIGN_IN_SCHEME) return
        awaitingBrowser = false
        leftForBrowser = false
        lifecycleScope.launch { container.session.completeSignIn(data.toString()) }
    }

    private fun openSignInTab(url: String) {
        try {
            awaitingBrowser = true
            CustomTabsIntent.Builder().build().launchUrl(this, Uri.parse(url))
        } catch (e: ActivityNotFoundException) {
            awaitingBrowser = false
            container.session.reportError("No web browser is installed to complete the sign-in: ${e.message}")
        }
    }
}
