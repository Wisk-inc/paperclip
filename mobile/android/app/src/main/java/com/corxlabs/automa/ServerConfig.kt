package app.automa.android

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
         * GET /api/health on a background thread. Returns null on success or a
         * sentence the connect screen can show.
         */
        fun checkHealth(serverUrl: String): HealthResult {
            return try {
                val connection = URL("$serverUrl/api/health").openConnection() as HttpURLConnection
                connection.connectTimeout = 8000
                connection.readTimeout = 8000
                connection.setRequestProperty("Accept", "application/json")
                val code = connection.responseCode
                val body = (if (code in 200..299) connection.inputStream else connection.errorStream)
                    ?.bufferedReader()?.use { it.readText() } ?: ""
                connection.disconnect()
                if (code !in 200..299) return HealthResult(false, "The server answered with HTTP $code. Is this an Automa server?")
                val json = runCatching { JSONObject(body) }.getOrNull()
                    ?: return HealthResult(false, "That address answered, but not like an Automa server.")
                if (json.optString("status") != "ok") return HealthResult(false, "The Automa server is starting or unhealthy. Try again in a moment.")
                HealthResult(true, null, json.optString("deploymentMode"), json.optString("version"))
            } catch (error: java.net.UnknownHostException) {
                HealthResult(false, "Could not find that address. Check the spelling and that this phone is on the same network or tailnet.")
            } catch (error: java.net.ConnectException) {
                HealthResult(false, "Nothing answered there. Make sure Automa is running and listening on your network (not only on localhost).")
            } catch (error: java.net.SocketTimeoutException) {
                HealthResult(false, "The server took too long to answer. Check your network or VPN.")
            } catch (error: javax.net.ssl.SSLException) {
                HealthResult(false, "The secure connection failed. Use a valid HTTPS certificate or connect over your private network.")
            } catch (error: Exception) {
                HealthResult(false, error.message ?: "Could not connect")
            }
        }

        fun isLoopback(url: String): Boolean {
            val host = Uri.parse(url).host ?: return false
            return host == "localhost" || runCatching { InetAddress.getByName(host).isLoopbackAddress }.getOrDefault(false)
        }
    }

    data class HealthResult(
        val ok: Boolean,
        val error: String?,
        val deploymentMode: String? = null,
        val version: String? = null,
    )
}
