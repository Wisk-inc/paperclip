package app.automa.android

import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebResourceResponse
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.FileInputStream
import java.util.UUID
import java.util.concurrent.ExecutorService

/**
 * `window.AutomaNative` — the contract implemented by ui/src/lib/automa-native.ts.
 *
 * Methods run on the WebView's JavaBridge thread. Every method checks which
 * page is calling: device methods answer only the configured Automa server,
 * connect methods answer only the bundled connect screen. File bytes never
 * travel through this bridge as strings; the page fetches them from
 * same-origin URLs under [NATIVE_PREFIX] that [intercept] serves locally.
 */
class AutomaBridge(
    private val activity: MainActivity,
    private val config: ServerConfig,
    private val sharedFolder: SharedFolder,
    private val incoming: IncomingShares,
    private val executor: ExecutorService,
) {
    /** Per-process secret in native file URLs, so only this page's scripts can build them. */
    private val token = UUID.randomUUID().toString().replace("-", "")

    /** Origin of the page currently shown; written on the main thread by the WebViewClient. */
    @Volatile
    var pageOrigin: String? = null

    private fun onServerPage(): Boolean = pageOrigin != null && pageOrigin == config.serverOrigin()
    private fun onConnectPage(): Boolean = pageOrigin == MainActivity.ASSETS_ORIGIN

    private fun error(message: String) = JSONObject().put("ok", false).put("error", message).toString()

    fun resolve(callId: String, json: String) {
        val script = "window.__automaNative && window.__automaNative.resolve(${JSONObject.quote(callId)}, ${JSONObject.quote(json)})"
        activity.runOnUiThread { activity.evaluate(script) }
    }

    // ─── Device (Automa server pages only) ─────────────────────────────────

    @JavascriptInterface
    fun getInfo(): String {
        if (!onServerPage()) return "null"
        return JSONObject()
            .put("clientKey", config.clientKey)
            .put("deviceName", deviceName())
            .put("platform", "android")
            .put("appVersion", BuildConfig.VERSION_NAME)
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
    fun getSharedFolder(): String = if (onServerPage()) sharedFolder.describeJson() else "null"

    @JavascriptInterface
    fun pickSharedFolder(callId: String) {
        if (!onServerPage()) return resolve(callId, error("Not available on this page"))
        activity.runOnUiThread { activity.pickFolder(callId) }
    }

    @JavascriptInterface
    fun clearSharedFolder() {
        if (onServerPage()) sharedFolder.clear()
    }

    @JavascriptInterface
    fun listSharedFolder(callId: String) {
        if (!onServerPage()) return resolve(callId, error("Not available on this page"))
        executor.execute { resolve(callId, sharedFolder.listJson()) }
    }

    @JavascriptInterface
    fun sharedFileUrl(path: String): String = if (onServerPage()) "$NATIVE_PREFIX/shared/$token?path=${Uri.encode(path)}" else ""

    @JavascriptInterface
    fun getIncomingShares(): String =
        if (onServerPage()) incoming.toJson { "$NATIVE_PREFIX/incoming/$token/${it.id}" } else "[]"

    @JavascriptInterface
    fun clearIncomingShares() {
        if (onServerPage()) incoming.clear()
    }

    @JavascriptInterface
    fun setDarkTheme(dark: Boolean) {
        activity.runOnUiThread { activity.applyTheme(dark) }
    }

    /** One of `tick`, `thud`, `success`, `warning`; see ui/src/lib/haptics.ts. */
    @JavascriptInterface
    fun haptic(kind: String) {
        if (!onServerPage() && !onConnectPage()) return
        activity.runOnUiThread { activity.performHaptic(kind) }
    }

    /** Blob/data downloads created by page scripts (exports, generated files). */
    @JavascriptInterface
    fun saveBase64(filename: String, mimeType: String, base64: String) {
        if (!onServerPage()) return
        executor.execute { activity.reportDownload(Downloads.saveBase64(activity, filename, mimeType, base64)) }
    }

    @JavascriptInterface
    fun openConnectScreen() {
        activity.runOnUiThread { activity.showConnect(null) }
    }

    // ─── Connect screen (bundled page only) ────────────────────────────────

    @JavascriptInterface
    fun getConnectState(): String {
        if (!onConnectPage()) return "null"
        return JSONObject()
            .put("serverUrl", config.serverUrl ?: JSONObject.NULL)
            .put("recent", JSONArray(config.recentServers))
            .put("appVersion", BuildConfig.VERSION_NAME)
            .toString()
    }

    @JavascriptInterface
    fun connect(input: String, callId: String) {
        if (!onConnectPage()) return resolve(callId, error("Not available on this page"))
        val url = ServerConfig.normalize(input)
            ?: return resolve(callId, error("Enter an address like 192.168.1.20:3100 or https://automa.example.com"))
        executor.execute {
            val health = ServerConfig.checkHealth(url)
            if (!health.ok) {
                resolve(callId, error(health.error ?: "Could not connect"))
                return@execute
            }
            resolve(
                callId,
                JSONObject()
                    .put("ok", true)
                    .put("url", url)
                    .put("insecure", url.startsWith("http://") && !ServerConfig.looksPrivate(Uri.parse(url).host ?: ""))
                    .toString(),
            )
            activity.runOnUiThread {
                config.remember(url)
                activity.loadServer()
            }
        }
    }

    @JavascriptInterface
    fun forgetServer(url: String) {
        if (onConnectPage()) config.forget(url)
    }

    @JavascriptInterface
    fun retry() {
        if (onConnectPage()) activity.runOnUiThread { activity.loadServer() }
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
                WebResourceResponse(item.contentType ?: "application/octet-stream", null, 200, "OK", noStore(), FileInputStream(item.file))
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
