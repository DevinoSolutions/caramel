package com.devino.caramel.web

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.os.Build
import android.util.Log
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import com.devino.caramel.BuildConfig
import java.io.ByteArrayInputStream

/** What the WebView reports to the Compose shell. */
interface ShellHost {
    /** A URL the [AppLinkGuard] refused after a user gesture: hand it to the system (or tell the shopper it was blocked), never load it. */
    fun openOutside(url: String)

    /**
     * A guarded URL is about to load. Returns true when the shell took over (sign-in, or a notice
     * explaining why there is none) and the navigation must not go on.
     */
    fun interceptSignInRoute(url: String): Boolean

    /** The page started loading: clears the last load error. */
    fun onLoadStarted()

    /** The WebView's visited history moved to [url] (full loads, redirects and pushState alike). */
    fun onPageVisited(url: String, webCanGoBack: Boolean)

    /** The main page failed to load (offline, DNS, TLS). */
    fun onMainFrameError(message: String)

    /** The renderer process died or was killed; the WebView is unusable and must be rebuilt. */
    fun onRenderProcessGone(crashed: Boolean)

    /** A main-frame request to a foreign origin (a form POST, say) was blocked; tell the shopper. Runs on the main thread. */
    fun onBlockedNavigation()
}

/**
 * Every top-level navigation passes through [AppLinkGuard] here. The check lives in the client, not
 * in the page, so a link, a redirect, `target=_blank` (multiple windows are off, so it arrives as a
 * normal navigation) and a script all meet it. Two hooks, because Android splits them:
 * `shouldOverrideUrlLoading` sees GET navigations (and their redirects), `shouldInterceptRequest`
 * sees every main-frame request including POST and its 307/308 redirects, which the first never does.
 */
class ShellWebViewClient(private val host: ShellHost) : WebViewClient() {
    // Whether the navigation that started the current chain was a tap. Only touched on the main thread.
    private var navigationHadGesture = false

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        // Iframes are the page's own embeds; only top-level navigation changes what the shopper is looking at.
        if (!request.isForMainFrame) return false
        val url = request.url.toString()
        val hadGesture = navigationHadGesture
        navigationHadGesture = NavigationPolicy.nextGestureState(request.hasGesture(), request.isRedirect, hadGesture)
        val allowed = AppLinkGuard.allowedTarget(url)
        if (allowed == null) {
            if (NavigationPolicy.mayOpenOutside(request.hasGesture(), request.isRedirect, hadGesture)) {
                host.openOutside(url)
            } else {
                // Cancelled on purpose: nothing the shopper tapped asked for this. No URL in the log (it may carry a token).
                Log.w(TAG, "Cancelled an off-origin navigation that had no user gesture")
            }
            return true
        }
        return host.interceptSignInRoute(allowed)
    }

    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
        if (!NavigationPolicy.blockMainFrameRequest(request.isForMainFrame, request.url.toString())) return null
        Log.w(TAG, "Blocked a main-frame ${request.method} request to a foreign origin")
        // Runs on a WebView background thread: the shopper-facing work goes back to the main thread.
        view.post {
            host.onBlockedNavigation()
            view.loadGuarded(ShellRoutes.homeUrl())
        }
        return WebResourceResponse("text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
    }

    override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
        host.onLoadStarted()
    }

    override fun onPageFinished(view: WebView, url: String?) {
        navigationHadGesture = false
        if (url != null) host.onPageVisited(url, view.canGoBack())
    }

    // Client-side routing (Next.js router.push) never calls shouldOverrideUrlLoading; this is where
    // a pushState to /login is seen. The page already moved on, so leave it for the Deals tab.
    override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
        if (url == null) return
        val allowed = AppLinkGuard.allowedTarget(url)
        if (allowed != null && host.interceptSignInRoute(allowed)) {
            view.post { view.loadGuarded(ShellRoutes.homeUrl()) }
            return
        }
        host.onPageVisited(url, view.canGoBack())
    }

    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
        if (request.isForMainFrame) host.onMainFrameError("${error.description} (error ${error.errorCode})")
    }

    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        host.onRenderProcessGone(detail.didCrash())
        return true
    }

    private companion object {
        const val TAG = "CaramelShell"
    }
}

/**
 * The ONLY place the shell calls WebView.loadUrl (LoadUrlSinkTest fails the build if another file
 * does). It re-checks [AppLinkGuard] at the sink, so a URL that slipped past a caller's own check
 * still cannot load. Returns false, and loads nothing, for a URL the guard refuses.
 */
fun WebView.loadGuarded(url: String): Boolean {
    val allowed = AppLinkGuard.allowedTarget(url) ?: return false
    loadUrl(allowed)
    return true
}

/**
 * Forgets the web session the WebView holds: cookies (flushed to disk) and DOM storage. Called on
 * sign-out and on account deletion so the next person on the device does not inherit it.
 * TODO(T-7852): once the web-session handoff exists, also end the session server-side.
 */
fun clearWebSessionState() {
    val cookies = CookieManager.getInstance()
    // Flush once the removal has finished; flushing right after the call could persist the old cookies.
    cookies.removeAllCookies { cookies.flush() }
    WebStorage.getInstance().deleteAllData()
}

/**
 * Builds the shell's WebView. Hardening (T-7817): no JavaScript bridge, no file or content access,
 * no extra windows, no mixed content, debugging only in debug builds. Safe Browsing is requested,
 * but it needs Google Play services, so it does nothing on Fire devices. JavaScript and DOM storage
 * stay on because the PWA needs them. Downloads and file choosers are not wired (not needed), so
 * those requests do nothing.
 */
@SuppressLint("SetJavaScriptEnabled") // 2026-10-24: grabcaramel.com is a JavaScript app; only AppLinkGuard-approved origins load here.
fun createShellWebView(context: Context, host: ShellHost): WebView {
    WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
    val webView = WebView(context)
    val settings = webView.settings
    settings.javaScriptEnabled = true
    settings.domStorageEnabled = true
    settings.allowFileAccess = false
    settings.allowContentAccess = false
    settings.setSupportMultipleWindows(false)
    settings.javaScriptCanOpenWindowsAutomatically = false
    settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
    settings.setSafeBrowsingEnabled(true) // needs Google Play services: a no-op on Fire
    settings.userAgentString = ShellUserAgent.append(settings.userAgentString, BuildConfig.VERSION_NAME, Build.MANUFACTURER)
    webView.webViewClient = ShellWebViewClient(host)
    return webView
}
