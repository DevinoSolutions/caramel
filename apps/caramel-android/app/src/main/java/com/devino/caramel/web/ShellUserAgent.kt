package com.devino.caramel.web

/**
 * The user-agent suffix the web app keys on (contract: GetItDone T-7853): the stock WebView user
 * agent plus " CaramelApp/<versionName> (android)", or "(fire)" on Amazon devices, then a SEPARATE
 * " CaramelBuild/<versionCode>" token (T-10055) so analytics can tell which build looped. The build
 * is its own token so the web app's CaramelApp matcher keeps matching on its own.
 */
object ShellUserAgent {
    fun suffix(versionName: String, manufacturer: String?, versionCode: Int): String {
        val platform = if (manufacturer.equals("Amazon", ignoreCase = true)) "fire" else "android"
        return " CaramelApp/$versionName ($platform) CaramelBuild/$versionCode"
    }

    fun append(baseUserAgent: String, versionName: String, manufacturer: String?, versionCode: Int): String =
        baseUserAgent + suffix(versionName, manufacturer, versionCode)
}
