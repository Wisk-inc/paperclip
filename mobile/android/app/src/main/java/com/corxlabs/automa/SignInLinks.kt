package com.corxlabs.automa

import java.net.URI
import java.net.URLDecoder

/**
 * Connector sign-in (OAuth) inside the app. The board sends the person to
 * the provider's sign-in page, and the provider sends them back to the
 * server's callback, which knows them only by the app's cookie: opened in
 * the phone's browser they arrived there signed out ("Board access
 * required") and the connector never connected. So a sign-in page that
 * returns to this server opens in the app, and the provider's own pages
 * (its login, its consent screen) stay in the app until it does.
 *
 * Plain Java parsing (no android.net.Uri), so the rules can be checked off
 * the phone.
 */
object SignInLinks {
    /** How long a sign-in may keep the provider's pages in the app; after it, links open in the browser again. */
    const val WINDOW_MS = 15 * 60_000L

    /** The origin of an address, by the same rule as [ServerConfig.originOf]. */
    fun originOf(url: String): String? {
        val uri = try {
            URI(url)
        } catch (_: Exception) {
            return null
        }
        val scheme = uri.scheme?.lowercase() ?: return null
        val host = uri.host?.lowercase() ?: return null
        if (scheme != "http" && scheme != "https") return null
        val defaultPort = if (scheme == "https") 443 else 80
        val port = if (uri.port == -1 || uri.port == defaultPort) "" else ":${uri.port}"
        return "$scheme://$host$port"
    }

    /**
     * Whether [url] is a sign-in page that returns to the server at
     * [serverOrigin]: an https page elsewhere whose OAuth `redirect_uri` is on
     * that server. Anything else (a plain link, a sign-in for another site)
     * still opens in the browser.
     */
    fun returnsTo(url: String, serverOrigin: String?): Boolean {
        if (serverOrigin == null) return false
        val uri = try {
            URI(url)
        } catch (_: Exception) {
            return false
        }
        if (uri.scheme?.lowercase() != "https" || uri.host.isNullOrEmpty()) return false
        if (originOf(url) == serverOrigin) return false
        val query = uri.rawQuery ?: return false
        return query.split('&').any { pair ->
            if (pair.substringBefore('=') != "redirect_uri") return@any false
            val target = decode(pair.substringAfter('=', "")) ?: return@any false
            originOf(target) == serverOrigin
        }
    }

    private fun decode(value: String): String? =
        try {
            URLDecoder.decode(value, "UTF-8")
        } catch (_: Exception) {
            null
        }
}
