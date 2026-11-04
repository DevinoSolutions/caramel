package com.devino.nativeauthtab

import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.browser.auth.AuthTabIntent
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent
import androidx.browser.customtabs.CustomTabsService

/**
 * Opens a browser sign-in for a native (non-Capacitor) shell, following the fleet NativeAuthTab
 * contract (dodomain-pwa-android docs/native-auth-tab.md): an explicit browser package chosen by
 * [BrowserChoice] (copied unchanged), never this app's own, and an Auth Tab where the browser
 * supports one (Chrome 137+), else a Custom Tab, else a plain browser.
 *
 * Auth Tab hands the redirect to [onReturn] directly. A Custom Tab or plain browser returns through
 * the manifest's `<callbackScheme>://auth/callback` intent-filter instead, so the activity's
 * onNewIntent handles that path. A closed tab delivers nothing here: the activity sees it as a
 * return to onResume with no callback, as before.
 *
 * Construct it while the activity is being created (a field initializer), because the Auth Tab
 * result launcher must be registered before the activity is STARTED.
 */
class SignInBrowser(private val activity: ComponentActivity, private val onReturn: (Uri) -> Unit) {
    private val authTab = activity.registerForActivityResult(AuthTabIntent.AuthenticateUserResultContract()) { result ->
        val uri = result.resultUri
        if (result.resultCode == AuthTabIntent.RESULT_OK && uri != null) onReturn(uri)
    }

    /**
     * Opens [url]. Returns false when the device has no browser but this app. Throws
     * ActivityNotFoundException when the chosen browser refuses the launch.
     */
    fun open(url: Uri, callbackScheme: String): Boolean {
        val browser = choose() ?: return false
        if (browser.mode == BrowserChoice.Mode.AUTH_TAB) {
            val authTabIntent = AuthTabIntent.Builder().build()
            // androidx 1.10 launch() only sets the data and the redirect extra, so the package holds.
            authTabIntent.intent.setPackage(browser.packageName)
            authTabIntent.launch(authTab, url, callbackScheme)
        } else {
            val intent = if (browser.mode == BrowserChoice.Mode.CUSTOM_TAB) {
                CustomTabsIntent.Builder().build().intent
            } else {
                Intent(Intent.ACTION_VIEW)
            }
            intent.data = url
            intent.setPackage(browser.packageName)
            activity.startActivity(intent)
        }
        return true
    }

    private fun choose(): BrowserChoice? {
        val providers = customTabsProviders(activity.packageManager)
        val defaultCustomTabs = if (providers.isEmpty()) null else CustomTabsClient.getPackageName(activity, providers)
        return BrowserChoice.choose(
            activity.packageName,
            defaultCustomTabs,
            providers,
            { pkg -> CustomTabsClient.isAuthTabSupported(activity, pkg) },
            browsers(activity.packageManager),
        )
    }

    private fun customTabsProviders(pm: PackageManager): List<String> {
        val intent = Intent(CustomTabsService.ACTION_CUSTOM_TABS_CONNECTION)
        val found = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            pm.queryIntentServices(intent, PackageManager.ResolveInfoFlags.of(0))
        } else {
            @Suppress("DEPRECATION") // The flags overload above is API 33+; minSdk is 26.
            pm.queryIntentServices(intent, 0)
        }
        return found.mapNotNull { it.serviceInfo?.packageName }
    }

    private fun browsers(pm: PackageManager): List<String> {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://")).addCategory(Intent.CATEGORY_BROWSABLE)
        val found = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            pm.queryIntentActivities(intent, PackageManager.ResolveInfoFlags.of(PackageManager.MATCH_ALL.toLong()))
        } else {
            @Suppress("DEPRECATION") // The flags overload above is API 33+; minSdk is 26.
            pm.queryIntentActivities(intent, PackageManager.MATCH_ALL)
        }
        return found.mapNotNull { it.activityInfo?.packageName }
    }
}
