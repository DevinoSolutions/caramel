package com.devino.caramel.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.graphics.vector.ImageVector
import android.os.SystemClock
import android.util.Log
import android.webkit.WebView
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.devino.caramel.AppContainer
import com.devino.caramel.BuildConfig
import com.devino.caramel.core.OAuthProvider
import com.devino.caramel.web.AccountAction
import com.devino.caramel.web.AccountPanel
import com.devino.caramel.web.AuthAction
import com.devino.caramel.web.ExternalLink
import com.devino.caramel.web.ExternalLinkPolicy
import com.devino.caramel.web.HandoffStep
import com.devino.caramel.web.LoginBounceOutcome
import com.devino.caramel.web.WebSessionLifecycle
import com.devino.caramel.web.ShellHost
import com.devino.caramel.web.ShellRoutes
import com.devino.caramel.web.ShellTab
import com.devino.caramel.web.SignInLoopGuard
import com.devino.caramel.web.clearWebSessionState
import com.devino.caramel.web.createShellWebView
import com.devino.caramel.web.loadGuarded
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.launch

private fun ShellTab.icon(): ImageVector = when (this) {
    ShellTab.DEALS -> Icons.Filled.Home
    ShellTab.SEARCH -> Icons.Filled.Search
    ShellTab.SAVED -> Icons.Filled.Favorite
    ShellTab.ACCOUNT -> Icons.Filled.Person
}

/**
 * The app shell: grabcaramel.com in a WebView under four tabs, plus the native sign-in sheet (the
 * only native screen left; Google refuses OAuth inside a WebView). Google signs in through
 * Credential Manager ([onStartGoogleSignIn]); Apple through the browser tab ([onStartSignIn]). The session store and the
 * Keystore-backed token live in [AppContainer].
 *
 * [requestedUrl] is an AppLinkGuard-approved URL from an intent (or null); the shell loads it and
 * calls [onRequestedUrlConsumed]. [notice] is a message for the shopper owned by the activity,
 * which also owns opening links outside ([onOpenOutside]). [devProofBearer] is the dev-only `devproof` build's session
 * bearer from the launch intent (core/DevProofSession.kt); it is always null, and never read, in release.
 */
@Composable
fun CaramelApp(
    container: AppContainer,
    requestedUrl: String?,
    onRequestedUrlConsumed: () -> Unit,
    notice: String?,
    onNotice: (String?) -> Unit,
    onStartSignIn: (String) -> Unit,
    onStartGoogleSignIn: (keepError: Boolean) -> Unit,
    onOpenOutside: (String) -> Unit,
    devProofBearer: String?,
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val session by container.session.state.collectAsStateWithLifecycle()
    val currentSession by rememberUpdatedState(session)
    val handoffFailure by container.webSession.failure.collectAsStateWithLifecycle()
    val currentOnNotice by rememberUpdatedState(onNotice)
    val currentOnOpenOutside by rememberUpdatedState(onOpenOutside)

    var selectedTab by remember { mutableStateOf(ShellTab.DEALS) }
    var canGoBack by remember { mutableStateOf(false) }
    var showSignIn by remember { mutableStateOf(false) }
    var showAccount by remember { mutableStateOf(false) }
    var confirmingDelete by remember { mutableStateOf(false) }
    var loadError by remember { mutableStateOf<String?>(null) }
    // Bumped to rebuild the WebView after its renderer process died.
    var webViewGeneration by remember { mutableIntStateOf(0) }
    // The sign-in loop cap (T-10055). Not keyed on webViewGeneration: a rebuilt WebView keeps the count and the latch.
    val signInLoop = remember { SignInLoopGuard() }
    var parkedOnSignIn by remember { mutableStateOf(false) }
    // Every explicit tap that loads or signs in calls this first, so the tap's own load runs unparked.
    val shopperTapped: () -> Unit = {
        signInLoop.userTapped()
        parkedOnSignIn = false
    }

    // The current WebView, readable from the host object built before it.
    val webViewHolder = remember { arrayOfNulls<WebView>(1) }

    // Whenever the native session ends (sign-out, account deletion, or a 401 from validate, deleteAccount or the handoff) the
    // next person on the device must not reach a signed-in page: wipe cookies, DOM storage and the HTTP cache, then discard
    // the WebView (and with it its back stack) for a fresh one, which loads Deals. Main thread only.
    val wipeWebSession: () -> Unit = {
        container.webSession.reset()
        clearWebSessionState()
        webViewHolder[0]?.clearCache(true)
        webViewGeneration += 1
    }
    // Every load goes through the sink guard (WebView.loadGuarded); a refusal is reported, not dropped. admitLoad refuses
    // a redeem URL the handoff did not issue, and any other load cancels a pending handoff (the latest tap wins).
    // [origin] says who asked: while the sign-in loop cap has parked the shell (T-10055), an AUTOMATIC load (home after a
    // WebView rebuild or a session change, an incoming link, a late handoff's redeem URL) is skipped and the handoff dropped.
    val navigate: (String, SignInLoopGuard.LoadOrigin) -> Unit = { url, origin ->
        if (!signInLoop.admitsLoad(origin)) {
            Log.w(TAG, "Skipped an automatic load: the shell is parked on sign-in until the shopper taps")
            container.webSession.cancelPending()
        } else if (!container.webSession.admitLoad(url)) {
            currentOnNotice("Caramel did not open a sign-in link because the app did not create it.")
        } else if (webViewHolder[0]?.loadGuarded(url) != true) {
            currentOnNotice("Caramel did not open a page because it is not on grabcaramel.com.")
        }
    }

    // What to do with a handoff attempt; a failure is already on screen through webSession.failure.
    val applyHandoffStep: (HandoffStep) -> Unit = { step ->
        when (step) {
            is HandoffStep.Load -> navigate(step.redeemUrl, SignInLoopGuard.LoadOrigin.AUTOMATIC)
            HandoffStep.SignInRequired -> showSignIn = true
            is HandoffStep.Failed, HandoffStep.Superseded -> Unit
        }
    }
    // UNDISPATCHED: the handoff's state changes happen before its first suspension, so a cancelled scope cannot strand them.
    val startHandoff: (String) -> Unit = { targetPath ->
        scope.launch(start = CoroutineStart.UNDISPATCHED) { applyHandoffStep(container.webSession.startFresh(targetPath)) }
    }

    // Wipe whenever the native token goes away or is replaced by another one (A to B skips null when a new sign-in lands while
    // A is still set). A new token that is still present then gets its own handoff, since the wipe superseded the one it started.
    var lastToken by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(session.token) {
        val previous = lastToken
        lastToken = session.token
        if (WebSessionLifecycle.shouldWipeWebSession(previous, session.token)) {
            wipeWebSession()
            if (WebSessionLifecycle.shouldRelinkAfterWipe(session.token)) startHandoff(ShellTab.DEALS.startPath)
        }
    }

    // Signing in natively while a token is still set (the link fallback) signs the old one out first, so its web session
    // and its server session end before another account can sign in.
    val signInWith: (OAuthProvider) -> Unit = { provider ->
        showSignIn = false
        scope.launch {
            val hadToken = container.session.token != null
            if (hadToken) {
                container.webSession.reset()
                container.session.signOut()
            }
            // A failed revoke from that sign-out stays on screen (keepError) instead of being cleared by the new sign-in.
            when (provider) {
                OAuthProvider.GOOGLE -> onStartGoogleSignIn(hadToken)
                OAuthProvider.APPLE -> container.session.beginSignIn(provider, keepError = hadToken)?.let(onStartSignIn)
            }
        }
    }

    // Launch: read the stored bearer, then confirm it is still alive (a 401 clears it). In the dev-only devproof build a
    // bearer from the launch intent replaces the stored one in between and is linked to the web tabs like a fresh sign-in.
    // The adoption lives in this one effect, after load(), so the store's own read can never land after it.
    LaunchedEffect(devProofBearer) {
        container.session.load()
        if (BuildConfig.DEV_PROOF && devProofBearer != null) {
            container.session.adoptDevProofBearer(devProofBearer)
        }
        container.session.validate()
        if (BuildConfig.DEV_PROOF && devProofBearer != null && container.session.token != null) {
            startHandoff(ShellTab.DEALS.startPath)
        }
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

            override fun interceptSignInRoute(url: String): Boolean {
                val action = ShellRoutes.authAction(url, currentSession.isSignedIn)
                if (action == AuthAction.NONE) return false
                // T-10055: every automatic sign-in request counts; past the cap the shell parks on "sign in"
                // (no prompt, no handoff, no posted home load) until the shopper taps.
                when (signInLoop.automaticSignInRequest(SystemClock.elapsedRealtime())) {
                    SignInLoopGuard.Admission.ADMITTED -> Unit
                    SignInLoopGuard.Admission.PARKED_NOW -> {
                        // TODO(T-10055): Sentry is not linked into the Android shell; add ONE breadcrumb and ONE
                        // captureMessage here (this runs once per park), tagged with the page path and versionCode.
                        Log.e(TAG, "Sign-in loop stopped: more than ${SignInLoopGuard.MAX_AUTOMATIC_REQUESTS} automatic sign-in requests in ${SignInLoopGuard.WINDOW_MILLIS / 1000} s; parked on sign-in until the shopper taps")
                        parkedOnSignIn = true
                        return true
                    }
                    SignInLoopGuard.Admission.PARKED -> return true
                }
                return when (action) {
                    AuthAction.NONE -> false
                    AuthAction.START_NATIVE_SIGN_IN -> {
                        showSignIn = true
                        true
                    }
                    AuthAction.LINK_WEB_SESSION -> {
                        // Includes /login?error=handoff_expired: at most one automatic handoff, then native sign-in.
                        scope.launch(start = CoroutineStart.UNDISPATCHED) {
                            when (val outcome = container.webSession.retryAfterLoginBounce(selectedTab.startPath)) {
                                LoginBounceOutcome.Ignore -> Unit
                                LoginBounceOutcome.NativeSignIn -> {
                                    currentOnNotice("Caramel could not link your sign-in to the web pages. Please sign in again.")
                                    showSignIn = true
                                }
                                is LoginBounceOutcome.Retried -> applyHandoffStep(outcome.step)
                            }
                        }
                        true
                    }
                }
            }

            override fun isParkedOnSignIn(): Boolean = signInLoop.isParked

            override fun onRefusedRedeemNavigation() {
                currentOnNotice("Caramel did not follow a sign-in link that the app did not create.")
            }

            override fun onBlockedNavigation() {
                currentOnNotice("Caramel blocked a page that tried to leave grabcaramel.com.")
            }

            override fun onLoadStarted() {
                loadError = null
            }

            override fun onPageVisited(url: String, webCanGoBack: Boolean) {
                container.webSession.onPageVisited(url)
                ShellRoutes.tabFor(url)?.let { selectedTab = it }
                canGoBack = webCanGoBack
            }

            override fun onMainFrameError(message: String) {
                container.webSession.onLoadFailed()
                loadError = "The page could not be loaded: $message"
            }

            override fun onRenderProcessGone(crashed: Boolean) {
                val reason = if (crashed) "crashed" else "was stopped by Android to free memory"
                container.webSession.onLoadFailed()
                currentOnNotice("The page $reason. Caramel restarted it on the Deals tab.")
                webViewGeneration += 1
            }
        }
    }
    val webView = remember(webViewGeneration) { createShellWebView(context, host) }
    webViewHolder[0] = webView
    var started by remember(webView) { mutableStateOf(false) }
    LaunchedEffect(webView, requestedUrl) {
        if (requestedUrl != null) {
            started = true
            navigate(requestedUrl, SignInLoopGuard.LoadOrigin.AUTOMATIC)
            onRequestedUrlConsumed()
        } else if (!started) {
            started = true
            navigate(ShellRoutes.homeUrl(), SignInLoopGuard.LoadOrigin.AUTOMATIC)
        }
    }

    BackHandler(enabled = canGoBack) { webView.goBack() }

    // Only ever called from a tap (a tab, Try again), after shopperTapped().
    val openTab: (ShellTab) -> Unit = { tab ->
        if (tab.needsWebSession && session.isSignedIn && !container.webSession.active) {
            // Signed in natively, no web session yet: link it first, landing on this tab.
            startHandoff(tab.startPath)
        } else {
            navigate(ShellRoutes.urlFor(tab), SignInLoopGuard.LoadOrigin.SHOPPER_TAP)
        }
    }

    Scaffold(
        bottomBar = {
            NavigationBar {
                ShellTab.entries.forEach { tab ->
                    NavigationBarItem(
                        selected = selectedTab == tab,
                        onClick = {
                            shopperTapped()
                            selectedTab = tab
                            openTab(tab)
                        },
                        icon = { Icon(tab.icon(), contentDescription = null) },
                        label = { Text(tab.label) },
                    )
                }
            }
        },
    ) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize()) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text("Caramel", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary)
                IconButton(onClick = { showAccount = true }) {
                    Icon(Icons.Filled.AccountCircle, contentDescription = "Account and privacy")
                }
            }
            session.errorMessage?.let { ErrorBanner(it, retryTitle = "Dismiss") { container.session.dismissError() } }
            notice?.let { ErrorBanner(it, retryTitle = "Dismiss") { onNotice(null) } }
            handoffFailure?.let {
                ErrorBanner(it) {
                    shopperTapped()
                    container.webSession.dismissFailure()
                    startHandoff(selectedTab.startPath)
                }
            }
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
                        ErrorBanner(message) {
                            shopperTapped()
                            webView.reload()
                        }
                    }
                }
                // Parked by the sign-in loop cap (T-10055): covers the page (a Surface takes the touches) until a tap.
                if (parkedOnSignIn) {
                    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
                        Column(
                            modifier = Modifier.fillMaxSize().padding(16.dp),
                            verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            Text("Sign in to see this page", style = MaterialTheme.typography.titleMedium)
                            Button(onClick = {
                                shopperTapped()
                                showSignIn = true
                            }) { Text("Sign in") }
                            TextButton(onClick = {
                                shopperTapped()
                                openTab(selectedTab)
                            }) { Text("Try again") }
                        }
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
                    Text("Google uses the accounts on this device. Apple sign-in opens in your browser.")
                    Button(
                        modifier = Modifier.fillMaxWidth(),
                        enabled = !session.isSigningIn,
                        onClick = { signInWith(OAuthProvider.APPLE) },
                    ) { Text("Continue with Apple") }
                    OutlinedButton(
                        modifier = Modifier.fillMaxWidth(),
                        enabled = !session.isSigningIn,
                        onClick = { signInWith(OAuthProvider.GOOGLE) },
                    ) { Text("Continue with Google") }
                }
            },
            confirmButton = { TextButton(onClick = { showSignIn = false }) { Text("Cancel") } },
        )
    }

    // Native on purpose: Google Play's account-deletion policy (and Apple 5.1.1(v) on the iOS twin)
    // needs in-app deletion while the app offers sign-in, and the web /profile has none yet.
    // TODO(T-7505): once the web deletion page ships and the WebView shows it, this dialog can move to the web.
    if (showAccount) {
        AlertDialog(
            onDismissRequest = { showAccount = false },
            title = { Text("Account & privacy") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(AccountPanel.signedInLine(session.isSignedIn, session.username))
                    AccountPanel.actions(session.isSignedIn).forEach { action ->
                        when (action) {
                            AccountAction.SIGN_IN -> Button(
                                modifier = Modifier.fillMaxWidth(),
                                onClick = {
                                    showAccount = false
                                    showSignIn = true
                                },
                            ) { Text("Sign in") }
                            AccountAction.SIGN_OUT -> OutlinedButton(
                                modifier = Modifier.fillMaxWidth(),
                                onClick = {
                                    showAccount = false
                                    scope.launch {
                                        // Reset first: a handoff answer arriving during the network revoke must not load for the old user.
                                        // The WebView wipe follows when the native token clears (see wipeWebSession above).
                                        container.webSession.reset()
                                        container.session.signOut()
                                    }
                                },
                            ) { Text("Sign out") }
                            AccountAction.DELETE_ACCOUNT -> OutlinedButton(
                                modifier = Modifier.fillMaxWidth(),
                                onClick = {
                                    showAccount = false
                                    confirmingDelete = true
                                },
                            ) { Text("Delete my account", color = MaterialTheme.colorScheme.error) }
                            AccountAction.PRIVACY_POLICY -> TextButton(
                                modifier = Modifier.fillMaxWidth(),
                                onClick = {
                                    showAccount = false
                                    shopperTapped()
                                    navigate(ShellRoutes.privacyUrl(), SignInLoopGuard.LoadOrigin.SHOPPER_TAP)
                                },
                            ) { Text("Privacy policy") }
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { showAccount = false }) { Text("Close") } },
        )
    }

    if (confirmingDelete) {
        AlertDialog(
            onDismissRequest = { confirmingDelete = false },
            title = { Text("Delete your account?") },
            text = {
                Text("This permanently deletes your Caramel account, your sign-ins and all your synced data, and signs you out everywhere. This cannot be undone.")
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmingDelete = false
                    // On success the session clears (signed out); on failure SessionStore.errorMessage shows in the banner.
                    scope.launch {
                        // Account deletion ends every server-side session, the web one included; the WebView wipe
                        // follows when the native token clears (see wipeWebSession above).
                        container.session.deleteAccount()
                    }
                }) { Text("Delete account", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmingDelete = false }) { Text("Cancel") } },
        )
    }
}

private const val TAG = "CaramelShell"
