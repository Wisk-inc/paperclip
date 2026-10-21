package com.corxlabs.automa

import android.app.Application
import android.content.Intent
import android.net.Uri
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat

class AutomaApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        publishShortcuts()
        Push.createChannel(this)
        Push.refreshToken(this)
    }

    /**
     * Long-press launcher shortcuts, built in code so they follow the package
     * name. The first ones are the actions a thumb reaches for most; launchers
     * show the top few, in this order.
     */
    private fun publishShortcuts() {
        fun shortcut(id: String, rank: Int, shortLabel: Int, longLabel: Int, glyph: Int, tint: Long, intent: Intent) =
            ShortcutInfoCompat.Builder(this, id)
                .setRank(rank)
                .setShortLabel(getString(shortLabel))
                .setLongLabel(getString(longLabel))
                .setIcon(ShortcutIcons.tile(this, glyph, tint.toInt()))
                .setIntent(intent.setClass(this, MainActivity::class.java))
                .build()

        fun open(path: String) = Intent(MainActivity.ACTION_OPEN_PATH, Uri.parse("automa-path:$path"))

        val shortcuts = listOf(
            shortcut("new_chat", 0, R.string.shortcut_new_chat_short, R.string.shortcut_new_chat_long, R.drawable.ic_shortcut_chat, 0xFF8B5CF6, open("/chats")),
            shortcut("new_task", 1, R.string.shortcut_new_task_short, R.string.shortcut_new_task_long, R.drawable.ic_shortcut_new, 0xFF22C55E, open("/issues/new")),
            shortcut("studio", 2, R.string.shortcut_studio_short, R.string.shortcut_studio_long, R.drawable.ic_shortcut_studio, 0xFFF59E0B, open("/studio")),
            shortcut("change_server", 3, R.string.shortcut_server_short, R.string.shortcut_server_long, R.drawable.ic_shortcut_server, 0xFF22D3EE, Intent(MainActivity.ACTION_CHANGE_SERVER)),
            shortcut("files", 4, R.string.shortcut_files_short, R.string.shortcut_files_long, R.drawable.ic_shortcut_files, 0xFF3B82F6, open("/device-files")),
        )
        runCatching {
            val max = ShortcutManagerCompat.getMaxShortcutCountPerActivity(this).coerceAtLeast(1)
            ShortcutManagerCompat.setDynamicShortcuts(this, shortcuts.take(max))
        }
    }
}
