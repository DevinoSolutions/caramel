package com.devino.caramel.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.devino.caramel.AppContainer
import com.devino.caramel.core.OAuthProvider
import com.devino.caramel.web.AuthAction
import com.devino.caramel.web.ExternalLink
import com.devino.caramel.web.ExternalLinkPolicy
import com.devino.caramel.web.ShellHost
import com.devino.caramel.web.ShellRoutes
import com.devino.caramel.web.ShellTab
import com.devino.caramel.web.createShellWebView
import kotlinx.coroutines.launch

private fun ShellTab.icon(): ImageVector = when (this) {
    ShellTab.DEALS -> Icons.Filled.Home
    ShellTab.SEARCH -> Icons.Filled.Search
    ShellTab.SAVED -> Icons.Filled.Favorite
    ShellTab.ACCOUNT -> Icons.Filled.Person
}

/**
 * The app shell: grabcaramel.com in a WebView under four tabs, plus the native sign-in sheet (the
 * only native screen left; Google refuses OAuth inside a WebView). The session store and the
 * Keystore-backed token live in [AppContainer].
 *
 * [requestedUrl] is an AppLinkGuard-approved URL from an intent (or null); the shell loads it and
 * calls [onRequestedUrlConsumed]. [notice] is a message for the shopper owned by the activity,
 * which also owns opening links outside ([onOpenOutside]).
 */
@Composable
fun CaramelApp(
    container: AppContainer,
    requestedUrl: String?,
    onRequestedUrlConsumed: () -> Unit,
    notice: String?,
    onNotice: (String?) -> Unit,
    onStartSignIn: (String) -> Unit,
    onOpenOutside: (String) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val session by container.session.state.collectAsStateWithLifecycle()
    val currentSession by rememberUpdatedState(session)
    val currentOnNotice by rememberUpdatedState(onNotice)
    val currentOnOpenOutside by rememberUpdatedState(onOpenOutside)

    var selectedTab by remember { mutableStateOf(ShellTab.DEALS) }
    var canGoBack by remember { mutableStateOf(false) }
    var showSignIn by remember { mutableStateOf(false) }
    var loadError by remember { mutableStateOf<String?>(null) }
    // Bumped to rebuild the WebView after its renderer process died.
    var webViewGeneration by remember { mutableIntStateOf(0) }

    // Launch: read the stored bearer, then confirm it is still alive (a 401 clears it).
    LaunchedEffect(Unit) {
        container.session.load()
        container.session.validate()
    }

    val host = remember(webViewGeneration) {
        object : ShellHost {
            override fun openOutside(url: String) {
                if (ExternalLinkPolicy.classify(url) == ExternalLink.BLOCKED) {
                    currentOnNotice("Caramel did not open a link because its address is not supported.")
                } else {
                    currentOnOpenOutside(url)
                }
            }

            override fun interceptSignInRoute(url: String): Boolean =
                when (ShellRoutes.authAction(url, currentSession.isSignedIn, container.webSessionActive)) {
                    AuthAction.NONE -> false
                    AuthAction.START_NATIVE_SIGN_IN -> {
                        showSignIn = true
                        true
                    }
                    AuthAction.SIGN_OUT_NATIVE_THEN_SIGN_IN -> {
                        scope.launch {
                            container.session.signOut()
                            showSignIn = true
                        }
                        true
                    }
                    AuthAction.WEB_SESSION_UNAVAILABLE -> {
                        // TODO(T-7852): replace with the web-session handoff once that endpoint exists.
                        currentOnNotice("You are signed in on this device, but the web pages are not signed in yet.")
                        true
                    }
                }

            override fun onLoadStarted() {
                loadError = null
            }

            override fun onPageVisited(url: String, webCanGoBack: Boolean) {
                ShellRoutes.tabFor(url)?.let { selectedTab = it }
                canGoBack = webCanGoBack
            }

            override fun onMainFrameError(message: String) {
                loadError = "The page could not be loaded: $message"
            }

            override fun onRenderProcessGone(crashed: Boolean) {
                val reason = if (crashed) "crashed" else "was stopped by Android to free memory"
                currentOnNotice("The page $reason. Caramel restarted it on the Deals tab.")
                webViewGeneration += 1
            }
        }
    }
    val webView = remember(webViewGeneration) { createShellWebView(context, host) }

    var started by remember(webView) { mutableStateOf(false) }
    LaunchedEffect(webView, requestedUrl) {
        if (requestedUrl != null) {
            started = true
            webView.loadUrl(requestedUrl)
            onRequestedUrlConsumed()
        } else if (!started) {
            started = true
            webView.loadUrl(ShellRoutes.homeUrl())
        }
    }

    BackHandler(enabled = canGoBack) { webView.goBack() }

    Scaffold(
        bottomBar = {
            NavigationBar {
                ShellTab.entries.forEach { tab ->
                    NavigationBarItem(
                        selected = selectedTab == tab,
                        onClick = {
                            selectedTab = tab
                            webView.loadUrl(ShellRoutes.urlFor(tab))
                        },
                        icon = { Icon(tab.icon(), contentDescription = null) },
                        label = { Text(tab.label) },
                    )
                }
            }
        },
    ) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize()) {
            session.errorMessage?.let { ErrorBanner(it, retryTitle = "Dismiss") { container.session.dismissError() } }
            notice?.let { ErrorBanner(it, retryTitle = "Dismiss") { onNotice(null) } }
            if (session.isSigningIn) {
                Text(
                    "Waiting for sign-in to finish...",
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                // Keyed so a rebuilt WebView (renderer died) gets a fresh AndroidView: its factory runs once.
                key(webViewGeneration) {
                    AndroidView(
                        modifier = Modifier.fillMaxSize(),
                        factory = { webView },
                        onRelease = { it.destroy() },
                    )
                }
                loadError?.let { message ->
                    Surface(modifier = Modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.surface) {
                        ErrorBanner(message) { webView.reload() }
                    }
                }
            }
        }
    }

    if (showSignIn) {
        AlertDialog(
            onDismissRequest = { showSignIn = false },
            title = { Text("Sign in to Caramel") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Sign-in opens in your browser, because Google does not allow it inside an app's web view.")
                    Button(
                        modifier = Modifier.fillMaxWidth(),
                        enabled = !session.isSigningIn,
                        onClick = {
                            showSignIn = false
                            scope.launch { container.session.beginSignIn(OAuthProvider.APPLE)?.let(onStartSignIn) }
                        },
                    ) { Text("Continue with Apple") }
                    OutlinedButton(
                        modifier = Modifier.fillMaxWidth(),
                        enabled = !session.isSigningIn,
                        onClick = {
                            showSignIn = false
                            scope.launch { container.session.beginSignIn(OAuthProvider.GOOGLE)?.let(onStartSignIn) }
                        },
                    ) { Text("Continue with Google") }
                }
            },
            confirmButton = { TextButton(onClick = { showSignIn = false }) { Text("Cancel") } },
        )
    }
}
