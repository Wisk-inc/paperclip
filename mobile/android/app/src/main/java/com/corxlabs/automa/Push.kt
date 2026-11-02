package com.corxlabs.automa

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Push notifications through Firebase Cloud Messaging. The page registers
 * this phone's token with the Automa server (as part of the device record);
 * the server sends a notification when something needs the person, for
 * example an agent asking for a file. Tapping it opens that screen.
 */
object Push {
    /** Data key the server uses for the screen to open, e.g. "/device-files". */
    const val PATH_KEY = "path"
    /** One notification per tag (e.g. "issue:<id>"): the newer one replaces it, from the page or the server alike. */
    const val TAG_KEY = "tag"
    /** "1" on news about finished work: shown only while Automa is out of sight. */
    const val AWAY_ONLY_KEY = "away_only"
    /** The registration the news is for; the app knows which server that is. */
    const val DEVICE_KEY = "device_id"
    /** Intent extra: the server origin a tapped notification belongs to. */
    const val ORIGIN_KEY = "automa_origin"

    private const val DEVICES_PREFS = "automa_push_devices"

    /** Remembers that registration [deviceId] belongs to the server at [origin]. */
    fun rememberDevice(context: Context, deviceId: String, origin: String) {
        context.getSharedPreferences(DEVICES_PREFS, Context.MODE_PRIVATE).edit().putString(deviceId, origin).apply()
    }

    fun originForDevice(context: Context, deviceId: String): String? =
        context.getSharedPreferences(DEVICES_PREFS, Context.MODE_PRIVATE).getString(deviceId, null)

    /** A forgotten server's registrations: its news is no longer shown. */
    fun forgetOrigin(context: Context, origin: String) {
        val prefs = context.getSharedPreferences(DEVICES_PREFS, Context.MODE_PRIVATE)
        val gone = prefs.all.filterValues { it == origin }.keys
        if (gone.isNotEmpty()) prefs.edit().apply { gone.forEach(::remove) }.apply()
    }

    private const val PREFS = "automa_push"
    private const val KEY_TOKEN = "token"

    fun token(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_TOKEN, null)

    fun saveToken(context: Context, token: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_TOKEN, token).apply()
    }

    /** Fetch the current token once at startup; FCM calls onNewToken on changes. */
    fun refreshToken(context: Context) {
        if (!FirebaseSupport.isReady(context)) return
        runCatching {
            FirebaseMessaging.getInstance().token.addOnSuccessListener { token -> saveToken(context, token) }
        }
    }

    fun createChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            context.getString(R.string.notification_channel_id),
            context.getString(R.string.notification_channel_name),
            NotificationManager.IMPORTANCE_HIGH,
        ).apply { description = context.getString(R.string.notification_channel_description) }
        context.getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
    }

    fun canNotify(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return false
        return NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    fun show(context: Context, title: String, body: String?, path: String?, tag: String? = null, origin: String? = null) {
        if (!canNotify(context)) return
        val id = ((origin ?: "") + (tag ?: path ?: title)).hashCode()
        val open = Intent(MainActivity.ACTION_OPEN_PATH, Uri.parse("automa-path:${path ?: "/"}"))
            .setClass(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .apply { if (origin != null) putExtra(ORIGIN_KEY, origin) }
        val pending = PendingIntent.getActivity(
            context,
            id,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, context.getString(R.string.notification_channel_id))
            .setSmallIcon(R.drawable.ic_stat_automa)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            // The page and the server can both report the same finished reply; the second updates it quietly.
            .setOnlyAlertOnce(true)
            .setContentIntent(pending)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(id, notification)
        } catch (_: SecurityException) {
            // Permission was revoked between the check and the post.
        }
    }
}

class PushMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        Push.saveToken(this, token)
    }

    /** Foreground messages (and data-only messages) arrive here; the system shows the rest. */
    override fun onMessageReceived(message: RemoteMessage) {
        val title = message.notification?.title ?: message.data["title"] ?: return
        val body = message.notification?.body ?: message.data["body"]
        // Which server sent it: a server the person forgot has no say on this phone.
        val origin = message.data[Push.DEVICE_KEY]?.let { Push.originForDevice(this, it) }
        if (origin != null && !ServerConfig(this).knowsOrigin(origin)) return
        // A finished reply the person is watching on screen needs no notification.
        if (message.data[Push.AWAY_ONLY_KEY] == "1" && MainActivity.onScreen) return
        Push.show(this, title, body, message.data[Push.PATH_KEY], message.data[Push.TAG_KEY], origin)
    }
}
