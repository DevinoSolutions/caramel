package com.devino.nativeauthtab;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * Which browser package a NativeAuthTab sign-in opens in, and how. Pure Java (no Android types)
 * so the rule is unit-tested; {@link NativeAuthTabPlugin} feeds it what PackageManager reports.
 *
 * <p>Why an explicit package at all (2026-10-26, DoDomain 1.0.9 on a Samsung phone): the sign-in
 * URL is on the app's own origin, which is a VERIFIED App Link. An implicit VIEW intent for it
 * resolves to the app itself, not a browser, so the shell loaded its own start URL in the WebView
 * and the provider page then fell out to the full browser app with no way back. Every launch must
 * name a browser package, and that package is never the app's own.
 *
 * <p>Preference, first match wins:
 * <ol>
 *   <li>The default browser, if it supports Auth Tab.</li>
 *   <li>Chrome (stable, beta, dev, canary), if installed and it supports Auth Tab.</li>
 *   <li>Any other installed browser that supports Auth Tab.</li>
 *   <li>The default Custom Tabs browser (e.g. Samsung Internet), as a Custom Tab.</li>
 *   <li>Any Custom Tabs browser, as a Custom Tab.</li>
 *   <li>Any browser at all, as a plain VIEW intent.</li>
 * </ol>
 * Auth Tab ranks first because it hands the result straight back to the app; a Custom Tab or a
 * plain browser returns through the {@code <applicationId>://auth/handoff} intent-filter instead.
 */
final class BrowserChoice {

    enum Mode {
        /** androidx AuthTabIntent; the browser returns the result to the launcher. */
        AUTH_TAB,
        /** A Custom Tab; the return arrives as a VIEW intent on the singleTask activity. */
        CUSTOM_TAB,
        /** A plain browser VIEW intent; same return path as {@link #CUSTOM_TAB}. */
        BROWSER
    }

    /** Answers whether a Custom Tabs provider package supports Auth Tab. */
    interface AuthTabSupport {
        boolean supports(String packageName);
    }

    static final List<String> CHROME_PACKAGES = Collections.unmodifiableList(Arrays.asList(
            "com.android.chrome", "com.chrome.beta", "com.chrome.dev", "com.chrome.canary"));

    final String packageName;
    final Mode mode;

    private BrowserChoice(String packageName, Mode mode) {
        this.packageName = packageName;
        this.mode = mode;
    }

    /**
     * @param ownPackage          the app's package; never chosen, whatever the inputs say
     * @param defaultCustomTabs   CustomTabsClient.getPackageName over the providers (the default
     *                            browser when it supports Custom Tabs), or null
     * @param customTabsProviders every package exposing a CustomTabsService, in PackageManager order
     * @param authTab             Auth Tab support per provider
     * @param plainBrowsers       every package handling a BROWSABLE https VIEW intent
     * @return the choice, or null when no browser other than the app itself exists
     */
    static BrowserChoice choose(
            String ownPackage,
            String defaultCustomTabs,
            List<String> customTabsProviders,
            AuthTabSupport authTab,
            List<String> plainBrowsers) {
        String preferred = isOther(defaultCustomTabs, ownPackage) ? defaultCustomTabs : null;
        List<String> providers = others(customTabsProviders, ownPackage);

        if (preferred != null && authTab.supports(preferred)) {
            return new BrowserChoice(preferred, Mode.AUTH_TAB);
        }
        for (String chrome : CHROME_PACKAGES) {
            if (providers.contains(chrome) && authTab.supports(chrome)) {
                return new BrowserChoice(chrome, Mode.AUTH_TAB);
            }
        }
        for (String provider : providers) {
            if (authTab.supports(provider)) {
                return new BrowserChoice(provider, Mode.AUTH_TAB);
            }
        }
        if (preferred != null) {
            return new BrowserChoice(preferred, Mode.CUSTOM_TAB);
        }
        if (!providers.isEmpty()) {
            return new BrowserChoice(providers.get(0), Mode.CUSTOM_TAB);
        }
        List<String> browsers = others(plainBrowsers, ownPackage);
        if (!browsers.isEmpty()) {
            return new BrowserChoice(browsers.get(0), Mode.BROWSER);
        }
        return null;
    }

    private static boolean isOther(String candidate, String ownPackage) {
        return candidate != null && !candidate.isEmpty() && !candidate.equals(ownPackage);
    }

    private static List<String> others(List<String> packages, String ownPackage) {
        List<String> out = new ArrayList<>();
        if (packages == null) return out;
        for (String p : packages) {
            if (isOther(p, ownPackage) && !out.contains(p)) out.add(p);
        }
        return out;
    }
}
