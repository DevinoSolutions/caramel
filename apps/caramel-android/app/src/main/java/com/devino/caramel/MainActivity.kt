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
        // A recreation (rotation) must not replay the same callback, and neither must a relaunch
        // from recents, which hands back the old launch intent. A callback that cold-starts a
        // reclaimed process cannot complete: the PKCE verifier lives in memory only (never
        // persisted), so it is refused with "no longer waiting" and the shopper signs in again.
        val fromHistory = intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0
        if (savedInstanceState == null && !fromHistory) handleCallback(intent)
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
        lifecycleScope.launch {
            // Only a callback that answers the pending sign-in ends the wait; a stray VIEW intent must
            // leave the real sign-in (and its disabled buttons) exactly as they were.
            if (container.session.completeSignIn(data.toString())) {
                awaitingBrowser = false
                leftForBrowser = false
            }
        }
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
