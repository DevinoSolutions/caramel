package com.devino.caramel.web

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.os.Build
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import com.devino.caramel.BuildConfig

/** What the WebView reports to the Compose shell. */
interface ShellHost {
    /** A URL the [AppLinkGuard] refused: hand it to the system (or tell the shopper it was blocked), never load it. */
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
}

/**
 * Every top-level navigation passes through [AppLinkGuard] here. The check lives in the client, not
 * in the page, so a link, a redirect, `target=_blank` (multiple windows are off, so it arrives as a
 * normal navigation) and a script all meet it.
 */
class ShellWebViewClient(private val host: ShellHost) : WebViewClient() {
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        // Iframes are the page's own embeds; only top-level navigation changes what the shopper is looking at.
        if (!request.isForMainFrame) return false
        val url = request.url.toString()
        val allowed = AppLinkGuard.allowedTarget(url)
        if (allowed == null) {
            host.openOutside(url)
            return true
        }
        return host.interceptSignInRoute(allowed)
    }

    override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
        host.onLoadStarted()
    }

    override fun onPageFinished(view: WebView, url: String?) {
        if (url != null) host.onPageVisited(url, view.canGoBack())
    }

    // Client-side routing (Next.js router.push) never calls shouldOverrideUrlLoading; this is where
    // a pushState to /login is seen. The page already moved on, so leave it for the Deals tab.
    override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
        if (url == null) return
        val allowed = AppLinkGuard.allowedTarget(url)
        if (allowed != null && host.interceptSignInRoute(allowed)) {
            view.post { view.loadUrl(ShellRoutes.homeUrl()) }
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
}

/**
 * Builds the shell's WebView. Hardening (T-7817): no JavaScript bridge, no file or content access,
 * no extra windows, no mixed content, Safe Browsing on, debugging only in debug builds. JavaScript
 * and DOM storage stay on because the PWA needs them. Downloads and file choosers are not wired
 * (not needed), so those requests do nothing.
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
    settings.setSafeBrowsingEnabled(true)
    settings.userAgentString = ShellUserAgent.append(settings.userAgentString, BuildConfig.VERSION_NAME, Build.MANUFACTURER)
    webView.webViewClient = ShellWebViewClient(host)
    return webView
}
