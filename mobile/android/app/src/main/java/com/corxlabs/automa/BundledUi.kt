package app.automa.android

import android.content.Context
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import org.json.JSONObject
import java.io.IOException

/**
 * The board UI shipped inside the APK (`assets/ui`, produced by
 * `pnpm mobile:bundle-ui`).
 *
 * Pages keep the server's origin, so sign-in cookies, the API, live updates,
 * and plugin UIs work exactly as in a browser; only the UI's own files are
 * answered from the APK instead of being downloaded from the server. Every
 * `/api/…` call, plugin UI, and MCP endpoint still goes to the server.
 *
 * When the APK was built without a bundle, nothing is intercepted and the
 * app shows the server's own UI.
 */
class BundledUi(private val context: Context) {
    private val files: Set<String> = loadManifest()

    val available: Boolean get() = INDEX in files

    fun intercept(request: WebResourceRequest, serverOrigin: String?): WebResourceResponse? {
        if (!available || serverOrigin == null || request.method != "GET") return null
        val url = request.url
        if (ServerConfig.originOf(url) != serverOrigin) return null
        val path = url.path ?: "/"
        if (SERVER_PREFIXES.any { path.startsWith(it) }) return null
        val relative = path.removePrefix("/")
        if (relative.isNotEmpty() && relative in files) return serve(relative)
        // A hashed file this bundle does not have belongs to another build: let the server answer.
        if (path.startsWith("/assets/")) return null
        // Board routes (/NOR/dashboard, /device-files, …) are all the single-page app.
        if (request.isForMainFrame || acceptsHtml(request)) return serve(INDEX)
        return null
    }

    private fun acceptsHtml(request: WebResourceRequest): Boolean =
        request.requestHeaders.entries.any { (name, value) ->
            name.equals("Accept", ignoreCase = true) && value.contains("text/html")
        }

    private fun serve(relative: String): WebResourceResponse? {
        val stream = try {
            context.assets.open("$ROOT/$relative")
        } catch (_: IOException) {
            return null
        }
        val mime = mimeType(relative)
        val textual = mime.startsWith("text/") || mime == "application/javascript" ||
            mime == "application/json" || mime == "application/manifest+json" || mime == "image/svg+xml"
        val headers = mapOf(
            "Cache-Control" to cacheControl(relative),
            "X-Content-Type-Options" to "nosniff",
        )
        return WebResourceResponse(mime, if (textual) "utf-8" else null, 200, "OK", headers, stream)
    }

    private fun cacheControl(relative: String): String = when {
        relative.startsWith("assets/") -> "public, max-age=31536000, immutable"
        relative == INDEX || relative == "sw.js" -> "no-cache"
        else -> "public, max-age=3600"
    }

    private fun loadManifest(): Set<String> = try {
        val json = context.assets.open("$ROOT/$MANIFEST").bufferedReader().use { it.readText() }
        val list = JSONObject(json).getJSONArray("files")
        buildSet { for (i in 0 until list.length()) add(list.getString(i)) }
    } catch (_: Exception) {
        emptySet()
    }

    companion object {
        private const val ROOT = "ui"
        private const val MANIFEST = "ui-manifest.json"
        private const val INDEX = "index.html"

        /** Paths only the server can answer. */
        private val SERVER_PREFIXES = listOf("/api/", "/_plugins/", "/mcp/", "/.well-known/")

        private val MIME_TYPES = mapOf(
            "html" to "text/html",
            "js" to "application/javascript",
            "mjs" to "application/javascript",
            "css" to "text/css",
            "json" to "application/json",
            "webmanifest" to "application/manifest+json",
            "svg" to "image/svg+xml",
            "png" to "image/png",
            "jpg" to "image/jpeg",
            "jpeg" to "image/jpeg",
            "webp" to "image/webp",
            "gif" to "image/gif",
            "ico" to "image/x-icon",
            "woff2" to "font/woff2",
            "woff" to "font/woff",
            "ttf" to "font/ttf",
            "wasm" to "application/wasm",
            "txt" to "text/plain",
            "md" to "text/markdown",
        )

        fun mimeType(relative: String): String =
            MIME_TYPES[relative.substringAfterLast('.', "").lowercase()] ?: "application/octet-stream"
    }
}
