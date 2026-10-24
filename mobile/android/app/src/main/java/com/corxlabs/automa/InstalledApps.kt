package com.corxlabs.automa

import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Build
import android.util.LruCache
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * The apps on this phone that have a launcher icon, for the App Inspector's
 * picker: name, icon, version and where the APK is. Visibility comes from the
 * LAUNCHER `<queries>` entry in the manifest, not QUERY_ALL_PACKAGES. Android
 * keeps installed APKs readable by every app, so the inspector reads the
 * chosen one from that path (or the page fetches it from a native URL).
 */
class InstalledApps(private val context: Context) {
    private val icons = object : LruCache<String, ByteArray>(6 * 1024 * 1024) {
        override fun sizeOf(key: String, value: ByteArray) = value.size
    }

    private val pm: PackageManager get() = context.packageManager

    /** `{ ok, apps: [...] }`; URLs are built by the caller (they carry the bridge token). */
    fun listJson(iconUrl: (String) -> String, apkUrl: (String) -> String): String {
        val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val activities = if (Build.VERSION.SDK_INT >= 33) {
            pm.queryIntentActivities(launcher, PackageManager.ResolveInfoFlags.of(0))
        } else {
            @Suppress("DEPRECATION")
            pm.queryIntentActivities(launcher, 0)
        }
        val seen = HashSet<String>()
        val rows = activities.mapNotNull { it.activityInfo?.applicationInfo }
            .filter { it.packageName != context.packageName && seen.add(it.packageName) }
            .mapNotNull { info -> runCatching { row(info, iconUrl, apkUrl) }.getOrNull() }
            .sortedBy { it.optString("label").lowercase() }
        val apps = JSONArray()
        rows.forEach { apps.put(it) }
        return JSONObject().put("ok", true).put("apps", apps).toString()
    }

    private fun row(info: ApplicationInfo, iconUrl: (String) -> String, apkUrl: (String) -> String): JSONObject {
        val pkg = info.packageName
        val packageInfo = packageInfo(pkg)
        val system = (info.flags and ApplicationInfo.FLAG_SYSTEM) != 0 &&
            (info.flags and ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) == 0
        val base = File(info.sourceDir)
        return JSONObject()
            .put("package", pkg)
            .put("label", pm.getApplicationLabel(info).toString().ifBlank { pkg }.take(120))
            .put("versionName", packageInfo?.versionName ?: JSONObject.NULL)
            .put("sourceDir", info.sourceDir)
            .put("splitCount", info.splitSourceDirs?.size ?: 0)
            .put("sizeBytes", base.length())
            .put("system", system)
            .put("updatedAt", packageInfo?.lastUpdateTime ?: 0L)
            .put("iconUrl", iconUrl(pkg))
            .put("apkUrl", apkUrl(pkg))
    }

    private fun packageInfo(pkg: String): PackageInfo? = runCatching {
        if (Build.VERSION.SDK_INT >= 33) {
            pm.getPackageInfo(pkg, PackageManager.PackageInfoFlags.of(0))
        } else {
            @Suppress("DEPRECATION")
            pm.getPackageInfo(pkg, 0)
        }
    }.getOrNull()

    private fun applicationInfo(pkg: String): ApplicationInfo? = runCatching {
        if (Build.VERSION.SDK_INT >= 33) {
            pm.getApplicationInfo(pkg, PackageManager.ApplicationInfoFlags.of(0))
        } else {
            @Suppress("DEPRECATION")
            pm.getApplicationInfo(pkg, 0)
        }
    }.getOrNull()

    /** The app's icon as a PNG, drawn at 96px (adaptive icons included). */
    fun iconPng(pkg: String): ByteArray? {
        if (!PACKAGE.matches(pkg)) return null
        icons.get(pkg)?.let { return it }
        val info = applicationInfo(pkg) ?: return null
        val drawable = runCatching { pm.getApplicationIcon(info) }.getOrNull() ?: return null
        val size = 96
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        drawable.setBounds(0, 0, size, size)
        drawable.draw(Canvas(bitmap))
        val bytes = ByteArrayOutputStream().use { out ->
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
            out.toByteArray()
        }
        bitmap.recycle()
        icons.put(pkg, bytes)
        return bytes
    }

    /** The app's base APK, when the package is visible and the file readable. */
    fun baseApk(pkg: String): File? {
        if (!PACKAGE.matches(pkg)) return null
        val file = applicationInfo(pkg)?.sourceDir?.let(::File) ?: return null
        return if (file.canRead()) file else null
    }

    companion object {
        private val PACKAGE = Regex("^[A-Za-z0-9_.]{1,256}$")
    }
}
