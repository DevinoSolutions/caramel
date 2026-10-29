package com.devino.caramel.web

/**
 * The user-agent suffix the web app keys on (contract: GetItDone T-7853): the stock WebView user
 * agent plus " CaramelApp/<versionName> (android)", or "(fire)" on Amazon devices.
 */
object ShellUserAgent {
    fun suffix(versionName: String, manufacturer: String?): String {
        val platform = if (manufacturer.equals("Amazon", ignoreCase = true)) "fire" else "android"
        return " CaramelApp/$versionName ($platform)"
    }

    fun append(baseUserAgent: String, versionName: String, manufacturer: String?): String =
        baseUserAgent + suffix(versionName, manufacturer)
}
