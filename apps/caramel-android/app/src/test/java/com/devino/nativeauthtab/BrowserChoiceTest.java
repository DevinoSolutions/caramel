package com.devino.nativeauthtab;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import org.junit.Test;

/**
 * 2026-10-26 (DoDomain 1.0.9): the sign-in URL is the app's own verified App Link, so the launch
 * must name a browser package, never the app's, and prefer an Auth Tab capable browser.
 */
public class BrowserChoiceTest {

    private static final String APP = "io.dodomain.app";
    private static final String CHROME = "com.android.chrome";
    private static final String SAMSUNG = "com.sec.android.app.sbrowser";
    private static final String FIREFOX = "org.mozilla.firefox";

    private static BrowserChoice.AuthTabSupport authTabIn(String... packages) {
        Set<String> set = new HashSet<>(Arrays.asList(packages));
        return set::contains;
    }

    private static List<String> list(String... packages) {
        return Arrays.asList(packages);
    }

    @Test
    public void samsungDefaultWithChromeInstalledUsesTheChromeAuthTab() {
        BrowserChoice c = BrowserChoice.choose(
                APP, SAMSUNG, list(SAMSUNG, CHROME), authTabIn(CHROME), list(SAMSUNG, CHROME));
        assertEquals(CHROME, c.packageName);
        assertEquals(BrowserChoice.Mode.AUTH_TAB, c.mode);
    }

    @Test
    public void anAuthTabCapableDefaultBrowserWinsOverChrome() {
        BrowserChoice c = BrowserChoice.choose(
                APP, FIREFOX, list(CHROME, FIREFOX), authTabIn(CHROME, FIREFOX), list(CHROME, FIREFOX));
        assertEquals(FIREFOX, c.packageName);
        assertEquals(BrowserChoice.Mode.AUTH_TAB, c.mode);
    }

    @Test
    public void withoutAnyAuthTabTheDefaultCustomTabsBrowserOpensACustomTab() {
        BrowserChoice c = BrowserChoice.choose(
                APP, SAMSUNG, list(FIREFOX, SAMSUNG), authTabIn(), list(FIREFOX, SAMSUNG));
        assertEquals(SAMSUNG, c.packageName);
        assertEquals(BrowserChoice.Mode.CUSTOM_TAB, c.mode);
    }

    @Test
    public void withoutADefaultTheFirstCustomTabsProviderIsUsed() {
        BrowserChoice c = BrowserChoice.choose(
                APP, null, list(FIREFOX, SAMSUNG), authTabIn(), list(SAMSUNG));
        assertEquals(FIREFOX, c.packageName);
        assertEquals(BrowserChoice.Mode.CUSTOM_TAB, c.mode);
    }

    @Test
    public void withoutCustomTabsAPlainBrowserIsUsed() {
        BrowserChoice c = BrowserChoice.choose(
                APP, null, Collections.<String>emptyList(), authTabIn(), list(APP, "com.example.browser"));
        assertEquals("com.example.browser", c.packageName);
        assertEquals(BrowserChoice.Mode.BROWSER, c.mode);
    }

    @Test
    public void theAppItselfIsNeverChosenWhateverTheInputsSay() {
        BrowserChoice c = BrowserChoice.choose(
                APP, APP, list(APP, SAMSUNG), authTabIn(APP), list(APP, SAMSUNG));
        assertEquals(SAMSUNG, c.packageName);
        assertEquals(BrowserChoice.Mode.CUSTOM_TAB, c.mode);

        assertNull(BrowserChoice.choose(APP, APP, list(APP), authTabIn(APP), list(APP)));
    }

    @Test
    public void noBrowserAtAllMeansNoChoice() {
        assertNull(BrowserChoice.choose(APP, null, null, authTabIn(), null));
    }
}
