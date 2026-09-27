package app.automa.android

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.webkit.CookieManager
import android.webkit.URLUtil
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLDecoder

/**
 * Saves files the page downloads (task attachments, device files, exports)
 * into Downloads/Automa. Requests carry the WebView session cookie, so
 * signed-in downloads work exactly as in the page.
 */
object Downloads {
    data class Result(val ok: Boolean, val filename: String, val publicFolder: Boolean)

    fun filenameFor(url: String, contentDisposition: String?, mimeType: String?): String {
        // Prefer RFC 6266 filename*=UTF-8''… (Automa sends it for non-ASCII names).
        contentDisposition?.let { header ->
            Regex("filename\\*\\s*=\\s*UTF-8''([^;]+)", RegexOption.IGNORE_CASE).find(header)?.let { match ->
                runCatching { return clean(URLDecoder.decode(match.groupValues[1].trim('"'), "UTF-8")) }
            }
            Regex("filename\\s*=\\s*\"?([^\";]+)\"?", RegexOption.IGNORE_CASE).find(header)?.let { match ->
                return clean(match.groupValues[1])
            }
        }
        return clean(URLUtil.guessFileName(url, contentDisposition, mimeType))
    }

    private fun clean(name: String) = name.replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]"), "_").trim().take(200).ifBlank { "download" }

    /** HTTP(S) download with the page's cookies. Call off the main thread. */
    fun fetch(context: Context, url: String, userAgent: String?, contentDisposition: String?, mimeType: String?): Result {
        var filename = filenameFor(url, contentDisposition, mimeType)
        return try {
            val connection = URL(url).openConnection() as HttpURLConnection
            connection.connectTimeout = 15000
            connection.readTimeout = 60000
            CookieManager.getInstance().getCookie(url)?.let { connection.setRequestProperty("Cookie", it) }
            userAgent?.let { connection.setRequestProperty("User-Agent", it) }
            if (connection.responseCode !in 200..299) {
                connection.disconnect()
                return Result(false, filename, false)
            }
            connection.getHeaderField("Content-Disposition")?.let { filename = filenameFor(url, it, mimeType) }
            val type = connection.contentType?.substringBefore(';') ?: mimeType ?: "application/octet-stream"
            val result = connection.inputStream.use { input -> save(context, filename, type, input) }
            connection.disconnect()
            result
        } catch (error: Exception) {
            Result(false, filename, false)
        }
    }

    fun saveBase64(context: Context, filename: String, mimeType: String?, base64: String): Result {
        val bytes = runCatching { Base64.decode(base64, Base64.DEFAULT) }.getOrNull()
            ?: return Result(false, filename, false)
        return save(context, clean(filename), mimeType ?: "application/octet-stream", bytes.inputStream())
    }

    fun saveDataUrl(context: Context, dataUrl: String, filename: String): Result {
        val header = dataUrl.substringBefore(',')
        val payload = dataUrl.substringAfter(',', "")
        val mime = header.removePrefix("data:").substringBefore(';').ifBlank { "application/octet-stream" }
        return if (header.endsWith(";base64")) saveBase64(context, filename, mime, payload)
        else save(context, clean(filename), mime, URLDecoder.decode(payload, "UTF-8").byteInputStream())
    }

    private fun save(context: Context, filename: String, mimeType: String, input: InputStream): Result {
        return if (Build.VERSION.SDK_INT >= 29) {
            val resolver = context.contentResolver
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, filename)
                put(MediaStore.Downloads.MIME_TYPE, mimeType)
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Automa")
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val item = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: return Result(false, filename, true)
            val ok = runCatching {
                resolver.openOutputStream(item)?.use { output -> copy(input, output) } != null
            }.getOrDefault(false)
            if (ok) {
                values.clear()
                values.put(MediaStore.Downloads.IS_PENDING, 0)
                resolver.update(item, values, null, null)
            } else {
                resolver.delete(item, null, null)
            }
            Result(ok, filename, true)
        } else {
            // Android 8–9: app-specific Downloads needs no storage permission.
            val dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: context.filesDir
            val target = uniqueFile(dir, filename)
            val ok = runCatching { target.outputStream().use { copy(input, it) }; true }.getOrDefault(false)
            Result(ok, target.name, false)
        }
    }

    private fun uniqueFile(dir: File, filename: String): File {
        var candidate = File(dir, filename)
        var counter = 1
        val base = filename.substringBeforeLast('.', filename)
        val ext = filename.substringAfterLast('.', "").let { if (it.isEmpty() || it == filename) "" else ".$it" }
        while (candidate.exists()) candidate = File(dir, "$base (${counter++})$ext")
        return candidate
    }

    private fun copy(input: InputStream, output: OutputStream) {
        input.copyTo(output, 64 * 1024)
    }
}
