package com.corxlabs.automa

import android.content.Context
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.URL
import java.util.UUID

/**
 * Which Automa server this phone talks to, plus the install's stable identity.
 *
 * The app is a client for a self-hosted Automa server (your computer, a cloud
 * VM, or Termux on this phone). Only that server's origin loads inside the
 * app; every other link opens in the browser.
 */
class ServerConfig(context: Context) {
    private val prefs = context.getSharedPreferences("automa", Context.MODE_PRIVATE)

    var serverUrl: String?
        get() = prefs.getString(KEY_SERVER, null)
        private set(value) {
            prefs.edit().putString(KEY_SERVER, value).apply()
        }

    val clientKey: String
        get() {
            prefs.getString(KEY_CLIENT, null)?.let { return it }
            val created = "android-" + UUID.randomUUID().toString()
            prefs.edit().putString(KEY_CLIENT, created).apply()
            return created
        }

    val recentServers: List<String>
        get() {
            val raw = prefs.getString(KEY_RECENT, null) ?: return emptyList()
            return runCatching {
                val array = JSONArray(raw)
                (0 until array.length()).map { array.getString(it) }
            }.getOrDefault(emptyList())
        }

    fun serverOrigin(): String? = serverUrl?.let { originOf(Uri.parse(it)) }

    fun isServerUrl(uri: Uri): Boolean {
        val origin = serverOrigin() ?: return false
        return originOf(uri) == origin
    }

    fun remember(url: String) {
        serverUrl = url
        val recent = (listOf(url) + recentServers.filter { it != url }).take(5)
        prefs.edit().putString(KEY_RECENT, JSONArray(recent).toString()).apply()
    }

    fun forget(url: String) {
        if (serverUrl == url) prefs.edit().remove(KEY_SERVER).apply()
        val recent = recentServers.filter { it != url }
        prefs.edit().putString(KEY_RECENT, JSONArray(recent).toString()).apply()
    }

    fun clearCurrent() {
        prefs.edit().remove(KEY_SERVER).apply()
    }

    companion object {
        private const val KEY_SERVER = "server_url"
        private const val KEY_RECENT = "recent_servers"
        private const val KEY_CLIENT = "client_key"

        fun originOf(uri: Uri): String? {
            val scheme = uri.scheme?.lowercase() ?: return null
            val host = uri.host?.lowercase() ?: return null
            if (scheme != "http" && scheme != "https") return null
            val port = if (uri.port == -1) "" else ":${uri.port}"
            return "$scheme://$host$port"
        }

        /** Accepts "192.168.1.5:3100", "automa.example.com", or a full URL. */
        fun normalize(input: String): String? {
            var value = input.trim()
            if (value.isEmpty()) return null
            if (!value.contains("://")) {
                val hostPart = value.substringBefore('/').substringBefore(':')
                value = (if (looksPrivate(hostPart)) "http://" else "https://") + value
            }
            val uri = Uri.parse(value)
            val origin = originOf(uri) ?: return null
            val path = (uri.path ?: "").trimEnd('/')
            return origin + path
        }

        fun looksPrivate(host: String): Boolean {
            val h = host.lowercase()
            if (h == "localhost" || h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".ts.net") || h.endsWith(".internal")) return true
            val parts = h.split('.').mapNotNull { it.toIntOrNull() }
            if (parts.size != 4) return false
            return parts[0] == 10 || parts[0] == 127 ||
                (parts[0] == 192 && parts[1] == 168) ||
                (parts[0] == 172 && parts[1] in 16..31) ||
                (parts[0] == 100 && parts[1] in 64..127)
        }

        /**
         * GET /api/health on a background thread and classify the outcome, so
         * the connect screen can say what went wrong in plain words.
         */
        fun checkHealth(serverUrl: String): HealthResult {
            return try {
                val connection = URL("$serverUrl/api/health").openConnection() as HttpURLConnection
                connection.connectTimeout = 8000
                connection.readTimeout = 8000
                connection.instanceFollowRedirects = true
                connection.setRequestProperty("Accept", "application/json")
                val code = connection.responseCode
                val body = (if (code in 200..299) connection.inputStream else connection.errorStream)
                    ?.bufferedReader()?.use { it.readText() } ?: ""
                connection.disconnect()
                if (code !in 200..299) return HealthResult(HealthKind.NOT_AUTOMA, "HTTP $code")
                val json = runCatching { JSONObject(body) }.getOrNull()
                    ?: return HealthResult(HealthKind.NOT_AUTOMA, "not JSON")
                if (!json.has("status")) return HealthResult(HealthKind.NOT_AUTOMA, "no status")
                if (json.optString("status") != "ok") return HealthResult(HealthKind.UNHEALTHY, json.optString("status"))
                HealthResult(HealthKind.OK, null, json.optString("deploymentMode"), json.optString("version"))
            } catch (error: java.net.UnknownHostException) {
                HealthResult(HealthKind.NOT_FOUND, error.message)
            } catch (error: java.net.ConnectException) {
                HealthResult(HealthKind.REFUSED, error.message)
            } catch (error: java.net.SocketTimeoutException) {
                HealthResult(HealthKind.TIMEOUT, error.message)
            } catch (error: javax.net.ssl.SSLException) {
                HealthResult(HealthKind.TLS, error.message)
            } catch (error: java.io.IOException) {
                // "Connection reset", "unexpected end of stream", broken pipe:
                // something listens there, but it does not speak HTTP to us.
                HealthResult(HealthKind.RESET, error.message)
            } catch (error: Exception) {
                HealthResult(HealthKind.RESET, error.message)
            }
        }

        /**
         * Tries the address as typed and, when no scheme was typed, the other
         * scheme too (a plain-HTTP server reached over https, or the reverse,
         * fails with a reset or a TLS error). Returns the URL that worked, or
         * the most useful failure.
         */
        fun probe(input: String, normalized: String): Pair<String, HealthResult> {
            val first = checkHealth(normalized)
            if (first.ok) return normalized to first
            // The address is this phone itself (often copied from Wireless
            // debugging). A server running on this phone (Termux) usually
            // listens on the loopback address, so try that before giving up.
            val uri = Uri.parse(normalized)
            val host = uri.host ?: ""
            if (isThisPhone(host)) {
                val ports = listOfNotNull(uri.port.takeIf { it != -1 && it !in 30000..49999 }, DEFAULT_PORT).distinct()
                for (port in ports) {
                    val local = "http://127.0.0.1:$port"
                    val result = checkHealth(local)
                    if (result.ok) return local to result
                }
            }
            if (input.contains("://")) return normalized to first
            if (first.kind != HealthKind.RESET && first.kind != HealthKind.TLS && first.kind != HealthKind.NOT_AUTOMA) {
                return normalized to first
            }
            val alternate = if (normalized.startsWith("https://")) "http://" + normalized.removePrefix("https://")
            else "https://" + normalized.removePrefix("http://")
            val second = checkHealth(alternate)
            return if (second.ok) alternate to second else normalized to first
        }

        /**
         * This phone's Wi-Fi (or Ethernet) IPv4 address, for pairing Wireless
         * debugging from a computer. Null when there is no such network.
         */
        fun localNetworkAddress(): String? = runCatching {
            java.net.NetworkInterface.getNetworkInterfaces().toList()
                .filter { it.isUp && !it.isLoopback && (it.name.startsWith("wlan") || it.name.startsWith("eth")) }
                .flatMap { it.inetAddresses.toList() }
                .firstOrNull { it is java.net.Inet4Address && !it.isLoopbackAddress && !it.isLinkLocalAddress }
                ?.hostAddress
        }.getOrNull()

        /** Automa's default port. */
        const val DEFAULT_PORT = 3100

        /** True when [host] is one of this phone's own network addresses. */
        fun isThisPhone(host: String): Boolean = runCatching {
            val target = InetAddress.getByName(host)
            if (target.isLoopbackAddress) return@runCatching false
            java.net.NetworkInterface.getNetworkInterfaces().toList().any { nif ->
                nif.inetAddresses.toList().any { it == target }
            }
        }.getOrDefault(false)

        /** A sentence for the connect screen, specific to what failed and where. */
        fun explain(url: String, result: HealthResult): String {
            val uri = Uri.parse(url)
            val host = uri.host ?: ""
            val port = if (uri.port == -1) null else uri.port
            if (isThisPhone(host)) {
                return "$host is this phone (it is what Wireless debugging shows), and Automa is not running on it yet. " +
                    "To use this phone as the server, follow \"Run Automa on this phone\" below. " +
                    "To use your computer instead, start Automa there with \"npx paperclipai onboard --bind lan\" and enter the address it prints."
            }
            if (isLoopback(url)) {
                return "Nothing answers on this phone at ${host}${port?.let { ":$it" } ?: ""}. Start Automa in Termux (see \"Run Automa on this phone\"), " +
                    "or link your computer over ADB: run \"adb reverse tcp:${port ?: DEFAULT_PORT} tcp:${port ?: DEFAULT_PORT}\" there (USB or Wireless debugging), then connect again."
            }
            val debugPortHint = if (port != null && port != 3100 && port in 30000..49999) {
                " Port $port looks like an Android Wireless debugging port, not Automa (Automa uses 3100 by default)."
            } else ""
            return when (result.kind) {
                HealthKind.NOT_FOUND -> "Could not find $host. Check the spelling and that this phone is on the same Wi-Fi or tailnet."
                HealthKind.REFUSED -> "Nothing is listening at $host${port?.let { ":$it" } ?: ""}. Start Automa with \"npx paperclipai onboard --bind lan\" so other devices can reach it, and check the port." + debugPortHint
                HealthKind.TIMEOUT -> "$host did not answer in time. Check that this phone is on the same network, and that a firewall on the computer allows port ${port ?: 3100}."
                HealthKind.RESET -> "Something at $host${port?.let { ":$it" } ?: ""} closed the connection. It is not an Automa server." +
                    debugPortHint + " Enter the address Automa prints when it starts, usually ending in :3100."
                HealthKind.TLS -> "The secure (HTTPS) connection to $host failed. For a server on your home network, enter the address without https://."
                HealthKind.NOT_AUTOMA -> "$host answered, but it is not an Automa server." + debugPortHint
                HealthKind.UNHEALTHY -> "Automa at $host is still starting. Try again in a moment."
                HealthKind.OK -> ""
            }
        }

        fun isLoopback(url: String): Boolean {
            val host = Uri.parse(url).host ?: return false
            return host == "localhost" || runCatching { InetAddress.getByName(host).isLoopbackAddress }.getOrDefault(false)
        }
    }

    enum class HealthKind { OK, NOT_FOUND, REFUSED, TIMEOUT, RESET, TLS, NOT_AUTOMA, UNHEALTHY }

    data class HealthResult(
        val kind: HealthKind,
        val detail: String?,
        val deploymentMode: String? = null,
        val version: String? = null,
    ) {
        val ok: Boolean get() = kind == HealthKind.OK
    }
}
