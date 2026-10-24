package com.devino.caramel

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.lifecycleScope
import com.devino.caramel.core.AppConfig
import com.devino.caramel.ui.CaramelApp
import com.devino.caramel.ui.CaramelTheme
import com.devino.caramel.web.ExternalLink
import com.devino.caramel.web.ExternalLinkPolicy
import com.devino.caramel.web.IntentTarget
import com.devino.caramel.web.ShellIntents
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private lateinit var container: AppContainer

    // True from the moment the sign-in tab opens until the callback arrives or the shopper returns.
    private var awaitingBrowser = false
    private var leftForBrowser = false

    // An AppLinkGuard-approved URL from an intent, waiting for the shell to load it.
    private var requestedUrl by mutableStateOf<String?>(null)

    // A message for the shopper that is not a sign-in error (a refused or unopenable link).
    private var notice by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        container = (application as CaramelApplication).container
        // A recreation (rotation) must not replay the same callback, and neither must a relaunch
        // from recents, which hands back the old launch intent. A callback that cold-starts a
        // reclaimed process cannot complete: the PKCE verifier lives in memory only (never
        // persisted), so it is refused with "no longer waiting" and the shopper signs in again.
        val fromHistory = intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0
        if (savedInstanceState == null && !fromHistory) {
            handleCallback(intent)
            navigateFromIntent(intent)
        }
        setContent {
            CaramelTheme {
                CaramelApp(
                    container = container,
                    requestedUrl = requestedUrl,
                    onRequestedUrlConsumed = { requestedUrl = null },
                    notice = notice,
                    onNotice = { notice = it },
                    onStartSignIn = ::openSignInTab,
                    onOpenOutside = ::openOutside,
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleCallback(intent)
        navigateFromIntent(intent)
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
                // TODO(T-7852): after native sign-in, POST /api/app/web-session/handoff with the bearer and
                // load the returned redeem URL (it must pass AppLinkGuard.allowedTarget) so the WebView gets
                // a web session, then set AppContainer.webSessionActive. Not written yet: the endpoint
                // does not exist, so the request and response shapes are unknown.
            }
        }
    }

    /**
     * MainActivity is exported: a VIEW intent's data and the start-path extra can come from any app.
     * Both are checked by AppLinkGuard (through ShellIntents) before anything reaches the WebView,
     * and a refused one is reported, not dropped.
     */
    private fun navigateFromIntent(intent: Intent?) {
        if (intent == null) return
        val target = ShellIntents.resolve(
            action = intent.action,
            dataString = intent.dataString,
            startPath = intent.getStringExtra(EXTRA_START_PATH),
            callbackScheme = AppConfig.SIGN_IN_SCHEME,
        )
        when (target) {
            IntentTarget.None -> Unit
            is IntentTarget.Load -> requestedUrl = target.url
            is IntentTarget.Refused -> notice = "Caramel did not open ${target.what} because it is not on grabcaramel.com."
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

    /** A link the page asked for that is not on grabcaramel.com: it opens outside the WebView, never in it. */
    private fun openOutside(url: String) {
        try {
            when (ExternalLinkPolicy.classify(url)) {
                ExternalLink.BROWSER -> CustomTabsIntent.Builder().build().launchUrl(this, Uri.parse(url))
                ExternalLink.MAIL_OR_PHONE -> startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                ExternalLink.BLOCKED -> notice = "Caramel did not open a link because its address is not supported."
            }
        } catch (e: ActivityNotFoundException) {
            notice = "No app on this device can open that link: ${e.message}"
        }
    }

    private companion object {
        /** A deep path (such as "/coupons") for another app or a notification to open; checked by AppLinkGuard. */
        const val EXTRA_START_PATH = "com.devino.caramel.START_PATH"
    }
}
