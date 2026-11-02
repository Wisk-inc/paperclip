package com.corxlabs.automa

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import org.json.JSONArray
import org.json.JSONObject
import java.io.InputStream
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap

/**
 * The one folder the person chose to share with their agents, read through
 * the Storage Access Framework. The app never asks for broad storage access:
 * Android grants it exactly this tree, and the grant can be revoked from the
 * Files page or the system settings at any time.
 *
 * The folder belongs to the server (origin) and organization it was shared
 * with: another server the app connects to later never sees it, and the
 * board shows it only in that organization.
 */
class SharedFolder(private val context: Context) {
    private val prefs = context.getSharedPreferences("automa", Context.MODE_PRIVATE)

    /** Relative path → document URI from the most recent listing. */
    private val index = ConcurrentHashMap<String, Uri>()

    val treeUri: Uri?
        get() = prefs.getString(KEY_TREE, null)?.let(Uri::parse)

    val name: String?
        get() = prefs.getString(KEY_NAME, null)

    /** The server origin the folder was shared with (null for one shared before 1.9.6). */
    val origin: String?
        get() = prefs.getString(KEY_ORIGIN, null)

    /** The organization it was shared with, when the page said (1.9.6 and newer). */
    val companyId: String?
        get() = prefs.getString(KEY_COMPANY, null)

    /**
     * True when the server at [currentOrigin] may use the folder. A folder
     * shared before origins were kept is bound to the first server that asks,
     * which is the one that was already reading it.
     */
    fun belongsTo(currentOrigin: String?): Boolean {
        if (currentOrigin == null || treeUri == null) return false
        val stored = origin ?: run {
            prefs.edit().putString(KEY_ORIGIN, currentOrigin).apply()
            currentOrigin
        }
        return stored == currentOrigin
    }

    /** Gives an older folder (no organization yet) to [company]; one that has an organization keeps it. */
    fun claimFor(company: String) {
        if (companyId == null && treeUri != null) prefs.edit().putString(KEY_COMPANY, company).apply()
    }

    fun select(tree: Uri, sharedWithOrigin: String? = null, sharedWithCompany: String? = null) {
        val resolver = context.contentResolver
        treeUri?.let { previous ->
            if (previous != tree) {
                runCatching { resolver.releasePersistableUriPermission(previous, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
            }
        }
        resolver.takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        prefs.edit()
            .putString(KEY_TREE, tree.toString())
            .putString(KEY_NAME, displayName(tree))
            .apply {
                if (sharedWithOrigin != null) putString(KEY_ORIGIN, sharedWithOrigin) else remove(KEY_ORIGIN)
                if (sharedWithCompany != null) putString(KEY_COMPANY, sharedWithCompany) else remove(KEY_COMPANY)
            }
            .apply()
        index.clear()
    }

    fun clear() {
        treeUri?.let { tree ->
            runCatching {
                context.contentResolver.releasePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
        }
        prefs.edit().remove(KEY_TREE).remove(KEY_NAME).remove(KEY_ORIGIN).remove(KEY_COMPANY).apply()
        index.clear()
    }

    fun describeJson(): String {
        val folderName = name ?: return "null"
        return JSONObject().put("name", folderName).put("companyId", companyId ?: JSONObject.NULL).toString()
    }

    private fun displayName(tree: Uri): String {
        val documentId = DocumentsContract.getTreeDocumentId(tree)
        val documentUri = DocumentsContract.buildDocumentUriUsingTree(tree, documentId)
        context.contentResolver.query(
            documentUri,
            arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME),
            null,
            null,
            null,
        )?.use { cursor ->
            if (cursor.moveToFirst()) return cursor.getString(0) ?: "Shared folder"
        }
        return documentId.substringAfterLast(':').substringAfterLast('/').ifBlank { "Shared folder" }
    }

    /**
     * Walk the shared tree breadth-first (bounded depth and count) and return
     * the listing the server stores for agents. One query per directory keeps
     * this fast even for a few thousand files.
     */
    fun listJson(): String {
        val tree = treeUri ?: return JSONObject().put("ok", false).put("error", "No folder is shared").toString()
        val resolver = context.contentResolver
        val entries = JSONArray()
        val found = HashMap<String, Uri>()
        val queue = ArrayDeque<Pair<String, String>>() // documentId to relative prefix
        queue.add(DocumentsContract.getTreeDocumentId(tree) to "")
        var truncated = false
        val projection = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        )
        try {
            while (queue.isNotEmpty()) {
                val (parentId, prefix) = queue.removeFirst()
                val depth = if (prefix.isEmpty()) 0 else prefix.count { it == '/' } + 1
                val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId)
                resolver.query(childrenUri, projection, null, null, null)?.use { cursor ->
                    while (cursor.moveToNext()) {
                        val id = cursor.getString(0) ?: continue
                        // The server refuses "/" and "\\" in paths, and paths over 1024 characters.
                        val displayName = cursor.getString(1)?.replace('/', '_')?.replace('\\', '_')?.trim().orEmpty()
                        if (displayName.isEmpty() || displayName == "." || displayName == ".." || displayName.startsWith(".")) continue
                        val mime = cursor.getString(2)
                        val path = if (prefix.isEmpty()) displayName else "$prefix/$displayName"
                        if (path.length > MAX_PATH_LENGTH) {
                            truncated = true
                            continue
                        }
                        if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                            if (depth < MAX_DEPTH) queue.add(id to path) else truncated = true
                            continue
                        }
                        if (entries.length() >= MAX_ENTRIES) {
                            truncated = true
                            continue
                        }
                        found[path] = DocumentsContract.buildDocumentUriUsingTree(tree, id)
                        val size = if (cursor.isNull(3)) JSONObject.NULL else cursor.getLong(3)
                        val modified = if (cursor.isNull(4) || cursor.getLong(4) <= 0) JSONObject.NULL else Instant.ofEpochMilli(cursor.getLong(4)).toString()
                        entries.put(
                            JSONObject()
                                .put("path", path)
                                .put("byteSize", size)
                                .put("contentType", mime ?: JSONObject.NULL)
                                .put("modifiedAt", modified),
                        )
                    }
                }
            }
        } catch (error: SecurityException) {
            clear()
            return JSONObject().put("ok", false).put("error", "Android revoked access to the shared folder. Share it again.").toString()
        } catch (error: RuntimeException) {
            // A folder deleted or moved while it is read, or a storage app that fails,
            // throws here; this runs on worker threads, where a throw ends the app.
            return JSONObject().put("ok", false).put("error", "The shared folder could not be read. If it was moved or deleted, share it again.").toString()
        }
        index.clear()
        index.putAll(found)
        return JSONObject()
            .put("ok", true)
            .put("name", name ?: "Shared folder")
            .put("entries", entries)
            .put("truncated", truncated)
            .toString()
    }

    /** Open a file by its relative path; only paths from the listing resolve. */
    fun open(path: String): Pair<InputStream, String?>? {
        if (treeUri == null) return null
        // Not in the last listing: the file may have been added since, so look again once.
        if (!index.containsKey(path)) listJson()
        val uri = index[path] ?: return null
        val resolver = context.contentResolver
        val stream = runCatching { resolver.openInputStream(uri) }.getOrNull() ?: return null
        return stream to resolver.getType(uri)
    }

    companion object {
        private const val KEY_TREE = "shared_tree"
        private const val KEY_NAME = "shared_tree_name"
        private const val KEY_ORIGIN = "shared_tree_origin"
        private const val KEY_COMPANY = "shared_tree_company"
        const val MAX_ENTRIES = 5000
        /** The server's limit for a shared path (validators/device-files.ts). */
        private const val MAX_PATH_LENGTH = 1024
        private const val MAX_DEPTH = 6
    }
}
