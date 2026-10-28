package com.corxlabs.automa

import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebResourceResponse
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.FileInputStream
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ExecutorService

/**
 * `window.AutomaNative` — the contract implemented by ui/src/lib/automa-native.ts.
 *
 * Methods run on the WebView's JavaBridge thread. Every method takes the page
 * key first: Android injects a JavaScript interface into every frame of the
 * WebView, including sandboxed previews of apps built in Studio and anything
 * else shown in a frame, so the key (handed only to the app's own pages, see
 * [MainActivity.installPageKey]) is what keeps those frames out. Device
 * methods answer only the configured Automa server, connect methods only the
 * bundled connect screen. Device file bytes never travel through this bridge
 * as strings; the page fetches them from same-origin URLs under
 * [NATIVE_PREFIX] that [intercept] serves locally. The one way in is a file
 * the page itself made (an export), which comes in bounded chunks.
 */
/** The largest file a page may save through [AutomaBridge.beginDownload]. */
private const val MAX_DOWNLOAD_BYTES = 2L * 1024 * 1024 * 1024

class AutomaBridge(
    private val activity: MainActivity,
    private val config: ServerConfig,
    private val sharedFolder: SharedFolder,
    private val incoming: IncomingShares,
    private val executor: ExecutorService,
    private val googleSignIn: GoogleSignIn,
) {
    /** Per-process secret in native file URLs, so only this page's scripts can build them. */
    private val token = UUID.randomUUID().toString().replace("-", "")

    private val installedApps = InstalledApps(activity)

    /** Per-process key the app's own pages receive as `window.__automaKey`; every method needs it. */
    val pageKey: String = UUID.randomUUID().toString().replace("-", "")

    /** Origin of the page currently shown; written on the main thread by the WebViewClient. */
    @Volatile
    var pageOrigin: String? = null

    private fun keyOk(key: String?): Boolean =
        key != null && MessageDigest.isEqual(key.toByteArray(Charsets.UTF_8), pageKey.toByteArray(Charsets.UTF_8))

    private fun onServerPage(key: String?): Boolean = keyOk(key) && pageOrigin != null && pageOrigin == config.serverOrigin()
    private fun onConnectPage(key: String?): Boolean = keyOk(key) && pageOrigin == MainActivity.ASSETS_ORIGIN
    private fun onAppPage(key: String?): Boolean = onServerPage(key) || onConnectPage(key)

    private fun error(message: String) = JSONObject().put("ok", false).put("error", message).toString()

    fun resolve(callId: String, json: String) {
        val script = "window.__automaNative && window.__automaNative.resolve(${JSONObject.quote(callId)}, ${JSONObject.quote(json)})"
        activity.runOnUiThread { activity.evaluate(script) }
    }

    // ─── Device (Automa server pages only) ─────────────────────────────────

    @JavascriptInterface
    fun getInfo(key: String?): String {
        if (!onServerPage(key)) return "null"
        return JSONObject()
            .put("clientKey", config.clientKey)
            .put("deviceName", deviceName())
            .put("platform", "android")
            .put("appVersion", BuildConfig.VERSION_NAME)
            .put("buildTime", BuildConfig.BUILD_TIME)
            .put("phoneAddress", ServerConfig.localNetworkAddress() ?: JSONObject.NULL)
            .put("sdkInt", Build.VERSION.SDK_INT)
            .toString()
    }

    private fun deviceName(): String {
        val userName = runCatching { Settings.Global.getString(activity.contentResolver, Settings.Global.DEVICE_NAME) }.getOrNull()
        if (!userName.isNullOrBlank()) return userName.take(120)
        val maker = Build.MANUFACTURER.replaceFirstChar { it.uppercase() }
        val model = Build.MODEL
        return (if (model.startsWith(maker, ignoreCase = true)) model else "$maker $model").take(120)
    }

    @JavascriptInterface
    fun getSharedFolder(key: String?): String = if (onServerPage(key)) sharedFolder.describeJson() else "null"

    @JavascriptInterface
    fun pickSharedFolder(key: String?, callId: String) {
        if (!onServerPage(key)) return resolve(callId, error("Not available on this page"))
        activity.runOnUiThread { activity.pickFolder(callId) }
    }

    @JavascriptInterface
    fun clearSharedFolder(key: String?) {
        if (onServerPage(key)) sharedFolder.clear()
    }

    @JavascriptInterface
    fun listSharedFolder(key: String?, callId: String) {
        if (!onServerPage(key)) return resolve(callId, error("Not available on this page"))
        executor.execute { resolve(callId, sharedFolder.listJson()) }
    }

    @JavascriptInterface
    fun sharedFileUrl(key: String?, path: String): String =
        if (onServerPage(key)) "$NATIVE_PREFIX/shared/$token?path=${Uri.encode(path)}" else ""

    /** Launchable apps on this phone for the App Inspector picker; icons and APKs come from native URLs. */
    @JavascriptInterface
    fun listInstalledApps(key: String?, callId: String) {
        if (!onServerPage(key)) return resolve(callId, error("Not available on this page"))
        executor.execute {
            val reply = runCatching {
                installedApps.listJson(
                    iconUrl = { "$NATIVE_PREFIX/appicon/$token/${Uri.encode(it)}" },
                    apkUrl = { "$NATIVE_PREFIX/apk/$token/${Uri.encode(it)}" },
                )
            }.getOrElse { error(it.message ?: "Could not list the apps on this phone") }
            resolve(callId, reply)
        }
    }

    @JavascriptInterface
    fun getIncomingShares(key: String?): String =
        if (onServerPage(key)) incoming.toJson { "$NATIVE_PREFIX/incoming/$token/${it.id}" } else "[]"

    @JavascriptInterface
    fun clearIncomingShares(key: String?) {
        if (onServerPage(key)) incoming.clear()
    }

    @JavascriptInterface
    fun setDarkTheme(key: String?, dark: Boolean) {
        if (onAppPage(key)) activity.runOnUiThread { activity.applyTheme(dark) }
    }

    /** One of `tick`, `thud`, `success`, `warning`; see ui/src/lib/haptics.ts. */
    @JavascriptInterface
    fun haptic(key: String?, kind: String) {
        if (!onAppPage(key)) return
        activity.runOnUiThread { activity.performHaptic(kind) }
    }

    /** Blob/data downloads created by page scripts (exports, generated files). */
    @JavascriptInterface
    fun saveBase64(key: String?, filename: String, mimeType: String, base64: String) {
        if (!onServerPage(key)) return
        executor.execute { activity.reportDownload(Downloads.saveBase64(activity, filename, mimeType, base64)) }
    }

    /*
     * Large blob downloads (a company or project export can be tens of MB)
     * arrive in chunks instead of one string: the whole file as base64 ran the
     * app out of memory. Chunks are written to a cache file as they come, then
     * the file is copied to Downloads. The calls are synchronous, so the
     * page's chunks arrive in order.
     */
    private class PendingDownload(val file: java.io.File, val filename: String, val mimeType: String) {
        var bytes = 0L
    }

    private val pendingDownloads = java.util.concurrent.ConcurrentHashMap<String, PendingDownload>()

    @JavascriptInterface
    fun beginDownload(key: String?, filename: String, mimeType: String): String {
        if (!onServerPage(key)) return ""
        val dir = java.io.File(activity.cacheDir, "downloads").apply { mkdirs() }
        val id = UUID.randomUUID().toString()
        val file = java.io.File(dir, "$id.part")
        if (!runCatching { file.createNewFile() }.getOrDefault(false)) return ""
        pendingDownloads[id] = PendingDownload(file, filename, mimeType)
        return id
    }

    @JavascriptInterface
    fun appendDownload(key: String?, id: String, base64: String): Boolean {
        if (!onServerPage(key)) return false
        val pending = pendingDownloads[id] ?: return false
        val bytes = runCatching { android.util.Base64.decode(base64, android.util.Base64.DEFAULT) }.getOrNull()
        if (bytes == null || pending.bytes + bytes.size > MAX_DOWNLOAD_BYTES) {
            cancelDownload(key, id)
            return false
        }
        val ok = runCatching { java.io.FileOutputStream(pending.file, true).use { it.write(bytes) } }.isSuccess
        if (!ok) {
            cancelDownload(key, id)
            return false
        }
        pending.bytes += bytes.size
        return true
    }

    @JavascriptInterface
    fun finishDownload(key: String?, id: String) {
        if (!onServerPage(key)) return
        val pending = pendingDownloads.remove(id) ?: return
        executor.execute {
            try {
                activity.reportDownload(Downloads.saveFile(activity, pending.filename, pending.mimeType, pending.file))
            } finally {
                pending.file.delete()
            }
        }
    }

    @JavascriptInterface
    fun cancelDownload(key: String?, id: String) {
        if (!keyOk(key)) return
        pendingDownloads.remove(id)?.file?.delete()
    }

    @JavascriptInterface
    fun openConnectScreen(key: String?) {
        if (onAppPage(key)) activity.runOnUiThread { activity.showConnect(null) }
    }

    // ─── Account and push (connect screen and Automa server pages) ─────────

    @JavascriptInterface
    fun getAuthState(key: String?): String = if (onAppPage(key)) googleSignIn.stateJson() else "null"

    @JavascriptInterface
    fun signInWithGoogle(key: String?, callId: String) {
        if (!onAppPage(key)) return resolve(callId, error("Not available on this page"))
        activity.runOnUiThread {
            googleSignIn.signIn { result ->
                result
                    .onSuccess {
                        activity.requestNotificationPermission()
                        resolve(callId, JSONObject(googleSignIn.stateJson()).put("ok", true).toString())
                    }
                    .onFailure { resolve(callId, error(it.message ?: "Google sign-in failed")) }
            }
        }
    }

    @JavascriptInterface
    fun signOut(key: String?) {
        if (onAppPage(key)) activity.runOnUiThread { googleSignIn.signOut() }
    }

    /**
     * A Firebase ID token for the server's "Continue with Google" sign-in,
     * signing in with Google first when needed. Server pages only.
     */
    @JavascriptInterface
    fun firebaseIdToken(key: String?, callId: String) {
        if (!onServerPage(key)) return resolve(callId, error("Not available on this page"))
        // A sign-in token on plain HTTP across the internet can be read on the way.
        val origin = config.serverOrigin() ?: ""
        if (origin.startsWith("http://") && !ServerConfig.looksPrivate(Uri.parse(origin).host ?: "")) {
            return resolve(callId, error("Sign in with Google needs an https:// address for a server outside your network."))
        }
        activity.runOnUiThread {
            val deliver = {
                googleSignIn.idToken { token ->
                    resolve(
                        callId,
                        if (token == null) error("Not signed in")
                        else JSONObject().put("ok", true).put("idToken", token).toString(),
                    )
                }
            }
            if (googleSignIn.currentUser != null) {
                deliver()
            } else {
                googleSignIn.signIn { result ->
                    result.onSuccess { deliver() }.onFailure { resolve(callId, error(it.message ?: "Google sign-in failed")) }
                }
            }
        }
    }

    /** This phone's push token, registered with the server as part of the device record. */
    @JavascriptInterface
    fun pushToken(key: String?): String = if (onServerPage(key)) Push.token(activity) ?: "" else ""

    // ─── Connect screen (bundled page only) ────────────────────────────────

    @JavascriptInterface
    fun getConnectState(key: String?): String {
        if (!onConnectPage(key)) return "null"
        val pending = config.pendingConnect
        return JSONObject()
            .put("serverUrl", config.serverUrl ?: JSONObject.NULL)
            .put("recent", JSONArray(config.recentServers))
            .put("appVersion", BuildConfig.VERSION_NAME)
            .put("buildTime", BuildConfig.BUILD_TIME)
            .put("phoneAddress", ServerConfig.localNetworkAddress() ?: JSONObject.NULL)
            // A connect request another app sent (Termux's launcher): shown, never applied without a tap.
            .put(
                "requested",
                pending?.let {
                    JSONObject()
                        .put("url", it.url)
                        .put("withKey", it.secret != null)
                        // The server this phone already uses: no tap needed, the
                        // page waits for it and opens Automa by itself.
                        .put("autoStart", it.url == config.serverUrl)
                } ?: JSONObject.NULL,
            )
            .put("waitFor", if (activity.waitingForServer) config.serverUrl ?: JSONObject.NULL else JSONObject.NULL)
            .toString()
    }

    /**
     * The board found this Automa locked and its own page without the key
     * (see LocalSecretNotice): the app re-applies the keys it holds, and
     * falls back to the connect screen with instructions.
     */
    @JavascriptInterface
    fun appKeyMissing(key: String?) {
        if (onServerPage(key)) activity.runOnUiThread { activity.recoverAppKey() }
    }

    @JavascriptInterface
    fun connect(key: String?, input: String, callId: String) {
        if (!onConnectPage(key)) return resolve(callId, error("Not available on this page"))
        startConnect(input, null, callId)
    }

    /**
     * Connects to Automa on this phone with an app key pasted from Termux
     * (`automa link`), for when the launcher could not hand it over itself.
     */
    @JavascriptInterface
    fun connectWithKey(key: String?, input: String, appKey: String, callId: String) {
        if (!onConnectPage(key)) return resolve(callId, error("Not available on this page"))
        val trimmed = appKey.trim()
        if (trimmed.length < ServerConfig.MIN_SECRET_LENGTH || trimmed.length > ServerConfig.MAX_SECRET_LENGTH) {
            return resolve(callId, error("That app key does not look right. In Termux, run: automa link"))
        }
        startConnect(input, trimmed, callId)
    }

    private fun startConnect(input: String, appKey: String?, callId: String) {
        val url = ServerConfig.normalize(input)
            ?: return resolve(callId, error("Enter an address like 192.168.1.20:3100 or https://automa.example.com"))
        if (appKey != null && !ServerConfig.isLoopback(url)) return resolve(callId, error("An app key is only for Automa running on this phone (127.0.0.1)."))
        executor.execute {
            val (reachedUrl, health) = ServerConfig.probe(input, url)
            if (!health.ok) {
                resolve(callId, error(ServerConfig.explain(reachedUrl, health)))
                return@execute
            }
            // A fresh install opens on setup: say so on the success screen.
            val origin = ServerConfig.originOf(Uri.parse(reachedUrl))
            val secret = appKey
                ?: config.pendingConnect?.takeIf { ServerConfig.originOf(Uri.parse(it.url)) == origin }?.secret
                ?: origin?.let(config::secretFor)
            val companyCount = ServerConfig.companyCount(reachedUrl, secret)
            // A locked Automa that refuses the key: say so, and keep the key
            // that works. Saving it anyway locked the board out until the
            // next `automa link`, and let another app swap the key unseen.
            if (health.locked && secret != null && companyCount == null) {
                if (config.pendingConnect?.secret == secret) config.pendingConnect = null
                resolve(callId, error("Automa on this phone rejected that app key. In Termux, run: automa link"))
                return@execute
            }
            resolve(
                callId,
                JSONObject()
                    .put("ok", true)
                    .put("url", reachedUrl)
                    .put("insecure", reachedUrl.startsWith("http://") && !ServerConfig.looksPrivate(Uri.parse(reachedUrl).host ?: ""))
                    .put("version", health.version ?: JSONObject.NULL)
                    .put("locked", health.locked)
                    .put("firstRun", companyCount == 0)
                    .toString(),
            )
            // The page shows its success screen first (see connect.js showConnected).
            activity.runOnUiThread { activity.finishConnect(reachedUrl, appKey, MainActivity.CONNECTED_SCREEN_MS) }
        }
    }

    /** Opens Developer options, for USB or Wireless debugging (ADB). Connect screen only. */
    @JavascriptInterface
    fun openDeveloperOptions(key: String?) {
        if (onConnectPage(key)) activity.runOnUiThread { activity.openDeveloperOptions() }
    }

    /** Opens the Wireless debugging screen when the phone has one, else Developer options. */
    @JavascriptInterface
    fun openWirelessDebugging(key: String?) {
        if (onConnectPage(key)) activity.runOnUiThread { activity.openWirelessDebugging() }
    }

    /** Whether Termux (to run Automa on this phone) is installed. Connect screen only. */
    @JavascriptInterface
    fun isTermuxInstalled(key: String?): Boolean = onConnectPage(key) && activity.isTermuxInstalled()

    /** Whether Android already lets this app run commands in Termux. Connect screen only. */
    @JavascriptInterface
    fun termuxRunPermissionGranted(key: String?): Boolean = onConnectPage(key) && activity.hasTermuxRunPermission()

    /**
     * Starts Automa in Termux in the background (asking for the permission the
     * first time). Replies {ok, output}, {ok, pending} or {ok:false, reason, error}.
     * Connect screen only.
     */
    @JavascriptInterface
    fun startAutomaInTermux(key: String?, callId: String) {
        if (!onConnectPage(key)) return resolve(callId, error("Not available on this page"))
        activity.runOnUiThread { activity.startAutomaInTermux { reply -> resolve(callId, reply.toString()) } }
    }

    /**
     * Like [startAutomaInTermux], but asks Termux even after it refused
     * before: the person fixed the setting and tapped "Try again".
     */
    @JavascriptInterface
    fun retryAutomaInTermux(key: String?, callId: String) {
        if (!onConnectPage(key)) return resolve(callId, error("Not available on this page"))
        activity.runOnUiThread { activity.startAutomaInTermux(force = true) { reply -> resolve(callId, reply.toString()) } }
    }

    /** Opens Termux, or its download page when it is not installed. Connect screen only. */
    @JavascriptInterface
    fun openTermux(key: String?) {
        if (onConnectPage(key)) activity.runOnUiThread { activity.openTermux() }
    }

    /** Whether this build carries the server that Termux installs ("Run Automa on this phone"). */
    @JavascriptInterface
    fun hasServerBundle(key: String?): Boolean = onConnectPage(key) && activity.hasServerBundle()

    /**
     * Hands the bundled server to Termux, which saves it as
     * ~/downloads/automa-server.tar.xz. Replies {ok} or {ok:false, error}. Connect screen only.
     */
    @JavascriptInterface
    fun sendServerToTermux(key: String?, callId: String) {
        if (!onConnectPage(key)) return resolve(callId, error("Not available on this page"))
        activity.sendServerToTermux { result ->
            resolve(
                callId,
                result.fold(
                    onSuccess = { JSONObject().put("ok", true).toString() },
                    onFailure = { error(it.message ?: "Could not send the setup to Termux") },
                ),
            )
        }
    }

    /** Copies text (setup commands) to the clipboard. Connect screen only. */
    @JavascriptInterface
    fun copyText(key: String?, text: String) {
        if (onConnectPage(key) && text.length <= 4096) activity.runOnUiThread { activity.copyToClipboard(text) }
    }

    @JavascriptInterface
    fun forgetServer(key: String?, url: String) {
        if (onConnectPage(key)) activity.runOnUiThread { activity.forgetServer(url) }
    }

    /** Drops a connect request another app sent, without connecting. Connect screen only. */
    @JavascriptInterface
    fun dismissRequested(key: String?) {
        if (onConnectPage(key)) config.pendingConnect = null
    }

    @JavascriptInterface
    fun retry(key: String?) {
        if (onConnectPage(key)) activity.runOnUiThread { activity.loadServer() }
    }

    // ─── Local file serving for the page ───────────────────────────────────

    fun intercept(uri: Uri): WebResourceResponse? {
        val path = uri.path ?: return null
        if (!path.startsWith(NATIVE_PREFIX) || !config.isServerUrl(uri)) return null
        val parts = path.removePrefix(NATIVE_PREFIX).trim('/').split('/')
        if (parts.size < 2 || parts[1] != token) return notFound()
        return when (parts[0]) {
            "shared" -> {
                val relative = uri.getQueryParameter("path") ?: return notFound()
                val (stream, type) = sharedFolder.open(relative) ?: return notFound()
                WebResourceResponse(type ?: "application/octet-stream", null, 200, "OK", noStore(), stream)
            }
            "incoming" -> {
                val item = parts.getOrNull(2)?.let(incoming::find) ?: return notFound()
                // The cached copy can be gone (Android clears caches); WebView rethrows
                // anything thrown here on the main thread, which ends the app.
                val stream = runCatching { FileInputStream(item.file) }.getOrNull() ?: return notFound()
                WebResourceResponse(item.contentType ?: "application/octet-stream", null, 200, "OK", noStore(), stream)
            }
            "appicon" -> {
                val png = parts.getOrNull(2)?.let { installedApps.iconPng(Uri.decode(it)) } ?: return notFound()
                WebResourceResponse("image/png", null, 200, "OK", noStore(), ByteArrayInputStream(png))
            }
            "apk" -> {
                val file = parts.getOrNull(2)?.let { installedApps.baseApk(Uri.decode(it)) } ?: return notFound()
                // Updated or uninstalled since the check: a 404, not a throw.
                val stream = runCatching { FileInputStream(file) }.getOrNull() ?: return notFound()
                val headers = noStore() + ("Content-Length" to file.length().toString())
                WebResourceResponse("application/vnd.android.package-archive", null, 200, "OK", headers, stream)
            }
            else -> notFound()
        }
    }

    private fun noStore() = mapOf("Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff")

    private fun notFound() = WebResourceResponse("text/plain", "utf-8", 404, "Not Found", noStore(), ByteArrayInputStream(ByteArray(0)))

    companion object {
        /** Under /api so the page's service worker never caches or rewrites it. */
        const val NATIVE_PREFIX = "/api/__automa_native__"
    }
}
