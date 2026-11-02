package com.corxlabs.automa

import android.content.Context
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.URL
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

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

    /**
     * A request to the server's machine that is not the server: another
     * program on another port (127.0.0.1:5173 beside 127.0.0.1:3100), or the
     * same host over another scheme. Cookies ignore ports, so the server's
     * app key would go along with it; the app refuses such requests.
     */
    fun isOtherServiceOnServerHost(uri: Uri): Boolean = otherServiceOnHost(serverOrigin(), uri)

    /**
     * The board page this phone was last on (path, query and hash), reopened
     * on the next launch so a restart lands where the person left off.
     */
    var lastPath: String?
        get() = prefs.getString(KEY_LAST_PATH, null)
        set(value) {
            prefs.edit().apply { if (value == null) remove(KEY_LAST_PATH) else putString(KEY_LAST_PATH, value) }.apply()
        }

    fun remember(url: String) {
        if (serverUrl != url) lastPath = null
        serverUrl = url
        val recent = (listOf(url) + recentServers.filter { it != url }).take(5)
        prefs.edit().putString(KEY_RECENT, JSONArray(recent).toString()).apply()
    }

    fun forget(url: String) {
        if (serverUrl == url) prefs.edit().remove(KEY_SERVER).apply()
        val recent = recentServers.filter { it != url }
        prefs.edit().putString(KEY_RECENT, JSONArray(recent).toString()).apply()
    }

    /** The saved server at [origin], current or recent. */
    fun savedUrlFor(origin: String): String? =
        (listOfNotNull(serverUrl) + recentServers).firstOrNull { originOf(Uri.parse(it)) == origin }

    fun knowsOrigin(origin: String): Boolean = savedUrlFor(origin) != null

    fun clearCurrent() {
        prefs.edit().remove(KEY_SERVER).apply()
    }

    /**
     * The app key of a locked Automa on this phone (PAPERCLIP_LOCAL_TRUSTED_SECRET,
     * see server/src/middleware/local-trusted-secret.ts), per origin. The app
     * sends it as a cookie; nothing else on the phone has it.
     */
    fun secretFor(origin: String): String? = prefs.getString(KEY_SECRET_PREFIX + origin, null)?.let(SecretStore::open)

    fun rememberSecret(origin: String, secret: String) {
        prefs.edit().putString(KEY_SECRET_PREFIX + origin, SecretStore.seal(secret)).apply()
    }

    fun forgetSecret(origin: String) {
        prefs.edit().remove(KEY_SECRET_PREFIX + origin).remove(KEY_PROVEN_PREFIX + origin).apply()
        forgetClearance(origin)
    }

    /**
     * Whether the server at [origin] has ever proved it holds the app key
     * ([proveServer]). From then on it always must: a program answering
     * without a proof is not taken for an older Automa.
     */
    fun hasProven(origin: String): Boolean = prefs.getBoolean(KEY_PROVEN_PREFIX + origin, false)

    private fun markProven(origin: String) {
        prefs.edit().putBoolean(KEY_PROVEN_PREFIX + origin, true).apply()
    }

    /**
     * How a server answered the app's challenge (see [proveServer]):
     * proved it holds the key; needs no key; gave no proof; gave a wrong
     * one; or could not be reached.
     */
    enum class Proof { PROVEN, NOT_LOCKED, NONE, WRONG, UNREACHABLE }

    /** What [clearKeyFor] found: may the key go to the server, and what it answered. */
    data class KeyCheck(val cleared: Boolean, val proof: Proof)

    /**
     * Checks, before the app key goes anywhere, that the server at [url]
     * holds it (see [proveServer]); a cleared key may then be sent for the
     * rest of this run. A server that answers without any proof and never
     * proved itself is an older Automa (from before proofs) and is trusted
     * as before. Call off the main thread.
     */
    fun clearKeyFor(url: String, secret: String): KeyCheck {
        val origin = originOf(Uri.parse(url)) ?: return KeyCheck(false, Proof.UNREACHABLE)
        if (isKeyCleared(origin, secret)) return KeyCheck(true, Proof.PROVEN)
        val proof = proveServer(url, secret)
        val cleared = when (proof) {
            Proof.PROVEN -> true.also { markProven(origin) }
            Proof.NONE -> !hasProven(origin)
            // A server that needs no key never gets it.
            Proof.NOT_LOCKED, Proof.WRONG, Proof.UNREACHABLE -> false
        }
        if (cleared) clearKey(origin, secret)
        return KeyCheck(cleared, proof)
    }

    /**
     * Whether [secret] is the key of the server at [url]: it proved so, or,
     * for an older Automa from before proofs, it accepted the key. Call off
     * the main thread.
     */
    fun keyWorks(url: String, secret: String): Boolean {
        val check = clearKeyFor(url, secret)
        if (!check.cleared) return false
        if (check.proof == Proof.PROVEN) return true
        if (companyCount(url, secret) != null) return true
        // The older server refused it: not a key to send again.
        originOf(Uri.parse(url))?.let { unclearKey(it, secret) }
        return false
    }

    /** A connect request another app sent (Termux's launcher). Applied only when the person taps Connect. */
    data class PendingConnect(val url: String, val secret: String?)

    var pendingConnect: PendingConnect?
        get() {
            val raw = prefs.getString(KEY_PENDING, null) ?: return null
            return runCatching {
                val json = JSONObject(raw)
                PendingConnect(json.getString("url"), json.optString("secret").takeIf { it.isNotEmpty() }?.let(SecretStore::open))
            }.getOrNull()
        }
        set(value) {
            if (value == null) {
                prefs.edit().remove(KEY_PENDING).apply()
            } else {
                // Sealed like every other app key (see SecretStore), even while it only waits for a tap.
                val secret = value.secret?.let(SecretStore::seal) ?: ""
                prefs.edit().putString(KEY_PENDING, JSONObject().put("url", value.url).put("secret", secret).toString()).apply()
            }
        }

    companion object {
        private const val KEY_SERVER = "server_url"
        private const val KEY_RECENT = "recent_servers"
        private const val KEY_CLIENT = "client_key"
        private const val KEY_SECRET_PREFIX = "secret:"
        private const val KEY_PROVEN_PREFIX = "proven:"
        private const val KEY_PENDING = "pending_connect"
        private const val KEY_LAST_PATH = "last_path"
        /** Bounds for an app key typed by hand; the server needs 16+ characters. */
        const val MIN_SECRET_LENGTH = 16
        const val MAX_SECRET_LENGTH = 256

        fun originOf(uri: Uri): String? {
            val scheme = uri.scheme?.lowercase() ?: return null
            val host = uri.host?.lowercase() ?: return null
            if (scheme != "http" && scheme != "https") return null
            // WebView drops a default port (https://host:443) from page URLs, so the
            // origin drops it too, or the two never match.
            val defaultPort = if (scheme == "https") 443 else 80
            val port = if (uri.port == -1 || uri.port == defaultPort) "" else ":${uri.port}"
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
                val json = runCatching { JSONObject(body) }.getOrNull()
                if (code !in 200..299) {
                    // Automa answers 503 with its own status while its database is
                    // not ready (Termux still starting PostgreSQL, say): that is
                    // Automa still starting, not some other server.
                    val status = json?.optString("status").orEmpty()
                    val starting = status == "unhealthy" || status == "starting" || json?.optString("error") == "database_unavailable"
                    return if (starting) {
                        HealthResult(HealthKind.UNHEALTHY, json?.optString("error")?.takeIf { it.isNotBlank() } ?: status)
                    } else {
                        HealthResult(HealthKind.NOT_AUTOMA, "HTTP $code")
                    }
                }
                if (json == null) return HealthResult(HealthKind.NOT_AUTOMA, "not JSON")
                if (!json.has("status")) return HealthResult(HealthKind.NOT_AUTOMA, "no status")
                if (json.optString("status") != "ok") return HealthResult(HealthKind.UNHEALTHY, json.optString("status"))
                HealthResult(HealthKind.OK, null, json.optString("deploymentMode"), json.optString("version"), json.optBoolean("localSecretRequired", false))
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
            // Automa answered: it is running and getting ready. Said before the
            // "nothing answers on this phone" advice, which is wrong once it answers.
            if (result.kind == HealthKind.UNHEALTHY) {
                val why = if (result.detail == "database_unreachable") " (its database is not answering yet)" else ""
                return if (isLoopback(url) || isThisPhone(host)) {
                    "Automa on this phone is still starting$why. Try again in a moment."
                } else {
                    "Automa at $host is still starting$why. Try again in a moment."
                }
            }
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

        /**
         * How many organizations the board can see, or null when the request was
         * refused or failed. Zero means a fresh install: the board opens on setup.
         */
        fun companyCount(serverUrl: String, secret: String?, sessionCookies: String? = null): Int? = runCatching {
            val connection = URL("$serverUrl/api/companies").openConnection() as HttpURLConnection
            connection.connectTimeout = 8000
            connection.readTimeout = 8000
            connection.setRequestProperty("Accept", "application/json")
            // The board's own sign-in (cookies the WebView holds), plus the app key for a locked Automa.
            val cookies = listOfNotNull(
                sessionCookies?.split(";")?.map { it.trim() }
                    ?.filter { it.isNotEmpty() && !it.startsWith("paperclip_local_secret=") }
                    ?.joinToString("; ")?.takeIf { it.isNotEmpty() },
                secret?.let { "paperclip_local_secret=${Uri.encode(it)}" },
            ).joinToString("; ")
            if (cookies.isNotEmpty()) connection.setRequestProperty("Cookie", cookies)
            val code = connection.responseCode
            val body = if (code in 200..299) connection.inputStream.bufferedReader().use { it.readText() } else null
            connection.disconnect()
            body?.let { JSONArray(it).length() }
        }.getOrNull()

        /** Shared with the server: server/src/auth/local-secret-proof.ts. */
        private const val PROOF_NONCE_HEADER = "x-automa-proof-nonce"
        private const val PROOF_HEADER = "x-automa-proof"

        /**
         * Asks the server at [serverUrl] to prove it holds [secret] without
         * sending it: a random challenge goes to /api/health, and only a
         * server with the key can answer with its HMAC (which also covers the
         * port, so a program on this port can't relay the challenge to the
         * real server elsewhere). Call off the main thread.
         */
        fun proveServer(serverUrl: String, secret: String): Proof {
            val nonce = ByteArray(32).also { SecureRandom().nextBytes(it) }.toHex()
            return try {
                val connection = URL("$serverUrl/api/health").openConnection() as HttpURLConnection
                connection.connectTimeout = 8000
                connection.readTimeout = 8000
                // An answer from wherever a redirect leads is not this server's.
                connection.instanceFollowRedirects = false
                connection.useCaches = false
                connection.setRequestProperty("Accept", "application/json")
                connection.setRequestProperty(PROOF_NONCE_HEADER, nonce)
                val code = connection.responseCode
                val answer = connection.getHeaderField(PROOF_HEADER)?.trim()?.lowercase()
                val body = runCatching {
                    (if (code in 200..299) connection.inputStream else connection.errorStream)?.bufferedReader()?.use { it.readText() }
                }.getOrNull()
                connection.disconnect()
                when {
                    // No answer: a server without a key (its health says it isn't
                    // locked), or one from before proofs, or not Automa at all.
                    answer.isNullOrEmpty() -> {
                        val health = body?.let { runCatching { JSONObject(it) }.getOrNull() }
                        val unlocked = code in 200..299 && health?.has("status") == true && !health.optBoolean("localSecretRequired", false)
                        if (unlocked) Proof.NOT_LOCKED else Proof.NONE
                    }
                    MessageDigest.isEqual(
                        proofFor(secret, portOf(serverUrl), nonce).toByteArray(Charsets.US_ASCII),
                        answer.toByteArray(Charsets.US_ASCII),
                    ) -> Proof.PROVEN
                    else -> Proof.WRONG
                }
            } catch (_: Exception) {
                Proof.UNREACHABLE
            }
        }

        /** The server's answer to [nonce]: the same HMAC as localSecretProof on the server. */
        fun proofFor(secret: String, port: Int, nonce: String): String {
            val mac = Mac.getInstance("HmacSHA256")
            mac.init(SecretKeySpec(secret.toByteArray(Charsets.UTF_8), "HmacSHA256"))
            return mac.doFinal("automa-local-secret-proof:v1:$port:$nonce".toByteArray(Charsets.UTF_8)).toHex()
        }

        private fun portOf(serverUrl: String): Int {
            val uri = Uri.parse(serverUrl)
            return if (uri.port != -1) uri.port else if (uri.scheme.equals("https", ignoreCase = true)) 443 else 80
        }

        private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

        /**
         * Keys cleared for sending in this run, by origin and a hash of the key
         * (never the key itself). Forgotten when the server goes away, so a
         * program that takes its port meanwhile must prove itself first.
         */
        private val clearedKeys: MutableSet<String> = ConcurrentHashMap.newKeySet()

        private fun clearanceId(origin: String, secret: String): String =
            origin + "|" + MessageDigest.getInstance("SHA-256").digest(secret.toByteArray(Charsets.UTF_8)).toHex()

        fun isKeyCleared(origin: String, secret: String): Boolean = clearanceId(origin, secret) in clearedKeys

        private fun clearKey(origin: String, secret: String) {
            clearedKeys.add(clearanceId(origin, secret))
        }

        private fun unclearKey(origin: String, secret: String) {
            clearedKeys.remove(clearanceId(origin, secret))
        }

        fun forgetClearance(origin: String) {
            clearedKeys.removeAll { it.startsWith("$origin|") }
        }

        /** See [isOtherServiceOnServerHost]; pure, for the given server origin. */
        fun otherServiceOnHost(serverOrigin: String?, uri: Uri): Boolean {
            val origin = serverOrigin ?: return false
            val serverHost = Uri.parse(origin).host?.lowercase() ?: return false
            val host = uri.host?.lowercase() ?: return false
            if (host != serverHost) return false
            return originOf(uri) != origin
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
        /** The instance only answers the app that holds its key (PAPERCLIP_LOCAL_TRUSTED_SECRET). */
        val locked: Boolean = false,
    ) {
        val ok: Boolean get() = kind == HealthKind.OK
    }
}
