package app.automa.android

import android.app.Application
import android.content.Intent
import android.net.Uri
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat

class AutomaApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        publishShortcuts()
    }

    /** Long-press launcher shortcuts; built in code so they follow the package name. */
    private fun publishShortcuts() {
        fun openPath(id: String, shortLabel: Int, longLabel: Int, icon: Int, path: String) =
            ShortcutInfoCompat.Builder(this, id)
                .setShortLabel(getString(shortLabel))
                .setLongLabel(getString(longLabel))
                .setIcon(IconCompat.createWithResource(this, icon))
                .setIntent(
                    Intent(MainActivity.ACTION_OPEN_PATH, Uri.parse("automa-path:$path"))
                        .setClass(this, MainActivity::class.java),
                )
                .build()

        val shortcuts = listOf(
            openPath("files", R.string.shortcut_files_short, R.string.shortcut_files_long, R.drawable.ic_shortcut_files, "/device-files"),
            openPath("new_task", R.string.shortcut_new_task_short, R.string.shortcut_new_task_long, R.drawable.ic_shortcut_new, "/issues/new"),
            ShortcutInfoCompat.Builder(this, "change_server")
                .setShortLabel(getString(R.string.shortcut_server_short))
                .setLongLabel(getString(R.string.shortcut_server_long))
                .setIcon(IconCompat.createWithResource(this, R.drawable.ic_shortcut_server))
                .setIntent(Intent(MainActivity.ACTION_CHANGE_SERVER).setClass(this, MainActivity::class.java))
                .build(),
        )
        runCatching { ShortcutManagerCompat.setDynamicShortcuts(this, shortcuts) }
    }
}
