package app.automa.android

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Files handed to Automa from the system share sheet. They are copied into
 * the app's private cache right away (share grants expire with the sending
 * app's task) and wait there until the person confirms on the Files page.
 * Nothing is uploaded without that confirmation.
 */
class IncomingShares(private val context: Context) {
    data class Item(val id: String, val name: String, val byteSize: Long, val contentType: String?, val file: File)

    private val items = CopyOnWriteArrayList<Item>()
    private val dir: File get() = File(context.cacheDir, "incoming").apply { mkdirs() }

    fun isShareIntent(intent: Intent?): Boolean =
        intent?.action == Intent.ACTION_SEND || intent?.action == Intent.ACTION_SEND_MULTIPLE

    /** Copy everything the intent carries. Call off the main thread. */
    fun accept(intent: Intent): Int {
        val uris = mutableListOf<Uri>()
        when (intent.action) {
            Intent.ACTION_SEND -> streamExtra(intent)?.let(uris::add)
            Intent.ACTION_SEND_MULTIPLE -> uris.addAll(streamListExtra(intent))
        }
        intent.clipData?.let { clip ->
            for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let { if (it !in uris) uris.add(it) }
        }
        var added = 0
        for (uri in uris) if (copy(uri)) added += 1
        if (uris.isEmpty()) {
            val text = intent.getStringExtra(Intent.EXTRA_TEXT)
            if (!text.isNullOrBlank()) {
                val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)?.takeIf { it.isNotBlank() } ?: "Shared text"
                val file = File(dir, "${UUID.randomUUID()}.txt").apply { writeText(text) }
                items.add(Item(UUID.randomUUID().toString(), sanitize("$subject.txt"), file.length(), "text/plain", file))
                added += 1
            }
        }
        return added
    }

    @Suppress("DEPRECATION")
    private fun streamExtra(intent: Intent): Uri? =
        if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else intent.getParcelableExtra(Intent.EXTRA_STREAM)

    @Suppress("DEPRECATION")
    private fun streamListExtra(intent: Intent): List<Uri> =
        (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)) ?: emptyList()

    private fun copy(uri: Uri): Boolean {
        if (uri.scheme != "content") return false // never read raw file paths handed in by other apps
        val resolver = context.contentResolver
        var name = "shared-file"
        var size = -1L
        runCatching {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    cursor.getString(0)?.let { name = it }
                    if (!cursor.isNull(1)) size = cursor.getLong(1)
                }
            }
        }
        val id = UUID.randomUUID().toString()
        val target = File(dir, id)
        val copied = runCatching {
            resolver.openInputStream(uri)?.use { input -> target.outputStream().use { input.copyTo(it) } } != null
        }.getOrDefault(false)
        if (!copied) {
            target.delete()
            return false
        }
        items.add(Item(id, sanitize(name), if (size >= 0) size else target.length(), resolver.getType(uri), target))
        return true
    }

    private fun sanitize(name: String) = name.replace(Regex("[\\\\/\\u0000-\\u001f]"), "_").take(200).ifBlank { "shared-file" }

    fun find(id: String): Item? = items.firstOrNull { it.id == id }

    fun toJson(urlFor: (Item) -> String): String {
        val array = JSONArray()
        for (item in items) {
            array.put(
                JSONObject()
                    .put("id", item.id)
                    .put("name", item.name)
                    .put("byteSize", item.byteSize)
                    .put("contentType", item.contentType ?: JSONObject.NULL)
                    .put("url", urlFor(item)),
            )
        }
        return array.toString()
    }

    fun clear() {
        items.forEach { it.file.delete() }
        items.clear()
    }

    fun isEmpty() = items.isEmpty()
}
