package com.devino.caramel

import com.devino.caramel.core.AppConfig
import com.devino.caramel.web.AppLinkGuard
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** T-7817: a link, a redirect, an intent or a start path must never load a foreign site in the shell. */
class AppLinkGuardTest {
    @Test
    fun acceptsTheAppOriginAndItsPaths() {
        val allowed = listOf(
            "https://grabcaramel.com",
            "https://grabcaramel.com/",
            "https://grabcaramel.com/coupons",
            "https://grabcaramel.com/coupons/stores",
            "https://grabcaramel.com/profile#favorites",
            "https://grabcaramel.com?x=1",
            "https://grabcaramel.com#a",
            "https://grabcaramel.com/?ref=email",
            "https://grabcaramel.com//evil.example", // still a path on grabcaramel.com
            "https://grabcaramel.com/@evil.example", // '@' after the first slash is path text
        )
        for (url in allowed) assertEquals(url, url, AppLinkGuard.allowedTarget(url))
    }

    @Test
    fun theGuardOriginIsTheOriginTheAppTalksTo() {
        assertEquals(AppConfig.WEBSITE_URL, AppLinkGuard.APP_ORIGIN)
        assertEquals(AppConfig.API_BASE_URL, AppLinkGuard.APP_ORIGIN)
    }

    @Test
    fun aPercentEncodedNewlineIsLiteralTextAndStaysAllowed() {
        // "%0a" is three printable characters; the WebView decodes it only inside the path or query, where it is data.
        val url = "https://grabcaramel.com/coupons?q=a%0Ab%0d%09"
        assertEquals(url, AppLinkGuard.allowedTarget(url))
        assertEquals("https://grabcaramel.com/%0a", AppLinkGuard.allowedTarget("https://grabcaramel.com/%0a"))
    }

    @Test
    fun refusesACraftedHostThatStartsWithTheAppHost() {
        assertNull(AppLinkGuard.allowedTarget("https://grabcaramel.com.evil.com"))
        assertNull(AppLinkGuard.allowedTarget("https://grabcaramel.com.evil.com/"))
        assertNull(AppLinkGuard.allowedTarget("https://grabcaramel.company/"))
        assertNull(AppLinkGuard.allowedTarget("https://grabcaramel.com-evil.com/"))
        assertNull(AppLinkGuard.allowedTarget("https://grabcaramel.com%0a.evil.com/"))
    }

    @Test
    fun refusesUserinfoPortAndBackslashTricks() {
        val refused = listOf(
            "https://grabcaramel.com@evil.com",
            "https://grabcaramel.com@evil.com/",
            "https://grabcaramel.com\\@evil.com",
            "https://grabcaramel.com\\@evil.com/",
            "https://grabcaramel.com:443evil",
            "https://grabcaramel.com:443/",
            "https://grabcaramel.com:8443/",
            "https://evil.com\\@grabcaramel.com/",
            "https://grabcaramel.com/\\evil",
            "https://grabcaramel.com/coupons\\",
        )
        for (url in refused) assertNull(url, AppLinkGuard.allowedTarget(url))
    }

    @Test
    fun refusesWhitespaceAndControlCharactersAnywhere() {
        val refused = listOf(
            " https://grabcaramel.com/",
            "https://grabcaramel.com/ ",
            "https://grabcaramel.com/ coupons",
            "\thttps://grabcaramel.com/",
            "https://grabcaramel.com/\t",
            "https://grabcaramel.com\t.evil.com/",
            "https://grabcaramel.com/\n",
            "https://grabcaramel.com/coupons\nhttps://evil.com",
            "https://grabcaramel.com/\r",
            "https://grabcaramel.com/\u0000",
            "https://grabcaramel.com/\u001f",
            "https://grabcaramel.com/\u007f",
            "https://grabcaramel.com/\u0085", // NEL
            "https://grabcaramel.com/ ", // no-break space
            "https://grabcaramel.com/ ", // line separator
            "https://grabcaramel.com/ ", // paragraph separator
            "https://grabcaramel.com/​", // zero-width space
            "https://grabcaramel.com/‮", // right-to-left override
            "https://grabcaramel.com/﻿",
            "https://grabcaramel.com/　", // ideographic space
        )
        for (url in refused) assertNull(url.map { it.code.toString(16) }.toString(), AppLinkGuard.allowedTarget(url))
    }

    @Test
    fun refusesOtherSchemesCaseTricksAndEmpty() {
        val refused = listOf(
            "",
            "http://grabcaramel.com/",
            "HTTPS://grabcaramel.com/",
            "Https://grabcaramel.com/",
            "https://GRABCARAMEL.COM/",
            "https://www.grabcaramel.com/",
            "https://evil.com/https://grabcaramel.com/",
            "javascript:alert(1)",
            "javascript://grabcaramel.com/%0aalert(1)",
            "data:text/html,<script>alert(1)</script>",
            "intent://grabcaramel.com/#Intent;scheme=https;end",
            "file:///data/data/com.devino.caramel/",
            "file://grabcaramel.com/etc/passwd",
            "content://grabcaramel.com/",
            "com.devino.caramel://auth/callback",
            "grabcaramel.com",
            "//grabcaramel.com/",
        )
        for (url in refused) assertNull(url, AppLinkGuard.allowedTarget(url))
        assertNull(AppLinkGuard.allowedTarget(null))
    }

    @Test
    fun startPathsStayOnTheAppOrigin() {
        assertEquals("https://grabcaramel.com/coupons", AppLinkGuard.targetForStartPath("/coupons"))
        assertEquals("https://grabcaramel.com/profile#favorites", AppLinkGuard.targetForStartPath("/profile#favorites"))
        assertEquals("https://grabcaramel.com/", AppLinkGuard.targetForStartPath("/"))
        assertNull(AppLinkGuard.targetForStartPath(null))
        assertNull(AppLinkGuard.targetForStartPath(""))
        assertNull(AppLinkGuard.targetForStartPath("coupons"))
        assertNull(AppLinkGuard.targetForStartPath("@evil.com/"))
        assertNull(AppLinkGuard.targetForStartPath(".evil.com/"))
        assertNull(AppLinkGuard.targetForStartPath("https://evil.com/"))
        assertNull(AppLinkGuard.targetForStartPath("/\\evil.com"))
        assertNull(AppLinkGuard.targetForStartPath("/coupons\n"))
    }
}
