package com.corxlabs.automa

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
 *
 * The queue is kept in a small index beside the copies, so it survives
 * Android rebuilding the screen (or ending the app) while the person is
 * elsewhere, and copies nobody is waiting on are deleted.
 */
class IncomingShares(private val context: Context) {
    data class Item(val id: String, val name: String, val byteSize: Long, val contentType: String?, val file: File)

    private val items = CopyOnWriteArrayList<Item>()
    private val dir: File get() = File(context.cacheDir, "incoming").apply { mkdirs() }
    private val indexFile: File get() = File(dir, INDEX_NAME)

    init {
        restore()
    }

    fun isShareIntent(intent: Intent?): Boolean =
        intent?.action == Intent.ACTION_SEND || intent?.action == Intent.ACTION_SEND_MULTIPLE

    /** Copy everything the intent carries. Call off the main thread. Returns how many files were kept. */
    @Synchronized
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
            // EXTRA_TEXT is a CharSequence: styled text (links, bold) is not a String,
            // which getStringExtra reads as null.
            val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
            if (!text.isNullOrBlank()) {
                val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)?.takeIf { it.isNotBlank() } ?: "Shared text"
                val id = UUID.randomUUID().toString()
                val file = File(dir, id).apply { writeText(text) }
                items.add(Item(id, sanitize("$subject.txt"), file.length(), "text/plain", file))
                added += 1
            }
        }
        if (added > 0) save()
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

    /** Drops one share (sent, or discarded on its own) and its copy. */
    @Synchronized
    fun remove(id: String): Boolean {
        val item = find(id) ?: return false
        items.remove(item)
        item.file.delete()
        save()
        return true
    }

    @Synchronized
    fun clear() {
        items.clear()
        sweep(emptySet())
        indexFile.delete()
    }

    fun isEmpty() = items.isEmpty()

    /** Rebuilds the queue the last screen left; copies Android already cleared are skipped. */
    @Synchronized
    private fun restore() {
        val saved = runCatching { JSONArray(indexFile.readText()) }.getOrNull()
        if (saved != null) {
            val home = dir.canonicalPath
            for (index in 0 until saved.length()) {
                val entry = saved.optJSONObject(index) ?: continue
                val file = File(dir, entry.optString("file"))
                if (!file.isFile || file.parentFile?.canonicalPath != home) continue
                val id = entry.optString("id")
                if (id.isBlank()) continue
                items.add(
                    Item(
                        id = id,
                        name = entry.optString("name").ifBlank { "shared-file" },
                        byteSize = entry.optLong("byteSize", file.length()),
                        // optString reads a JSON null as the text "null".
                        contentType = if (entry.isNull("contentType")) null else entry.optString("contentType").ifBlank { null },
                        file = file,
                    ),
                )
            }
        }
        sweep(items.map { it.file.name }.toSet())
    }

    /** Deletes every copy nobody is waiting on. */
    private fun sweep(keep: Set<String>) {
        dir.listFiles()?.forEach { file -> if (file.name != INDEX_NAME && file.name !in keep) file.delete() }
    }

    private fun save() {
        val array = JSONArray()
        for (item in items) {
            array.put(
                JSONObject()
                    .put("id", item.id)
                    .put("name", item.name)
                    .put("byteSize", item.byteSize)
                    .put("contentType", item.contentType ?: JSONObject.NULL)
                    .put("file", item.file.name),
            )
        }
        runCatching { indexFile.writeText(array.toString()) }
    }

    companion object {
        private const val INDEX_NAME = "queue.json"
    }
}
