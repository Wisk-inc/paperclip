package com.corxlabs.automa

import android.app.LocaleManager
import android.content.Context
import android.os.Build
import android.os.LocaleList

/**
 * The person's language choice on the board: "auto" (follow the phone) or one
 * of the languages Automa's screens come in. The app keeps it so the connect
 * screen opens in it, and on Android 13+ its own screens (connection notices,
 * shortcuts, messages) follow it too; "auto" leaves the phone's language.
 */
object AppLanguage {
    const val AUTO = "auto"

    /** The codes in packages/shared/src/app-languages.ts (APP_LANGUAGE_CODES); a test keeps them equal. */
    val CODES: Set<String> = setOf(
        "en", "ar", "bn", "cs", "da", "de", "el", "es", "fa", "fi",
        "fil", "fr", "he", "hi", "hu", "id", "it", "ja", "ko", "mr",
        "ms", "nb", "nl", "pa", "pl", "pt-BR", "pt-PT", "ro", "ru", "sv",
        "sw", "ta", "te", "th", "tr", "uk", "ur", "vi", "zh-CN", "zh-TW",
    )

    private const val PREFS = "automa"
    private const val KEY = "language"

    /** "auto" or a known code, as the board sends it; anything else is refused. */
    fun normalize(value: String?): String? {
        val choice = value?.trim() ?: return null
        return if (choice == AUTO || choice in CODES) choice else null
    }

    /** Where the choice is kept and how it is applied: SharedPreferences and LocaleManager in the app. */
    internal interface Target {
        var saved: String
        fun apply(choice: String)
    }

    private class AppTarget(private val context: Context) : Target {
        private val prefs get() = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        override var saved: String
            get() = normalize(prefs.getString(KEY, AUTO)) ?: AUTO
            set(value) { prefs.edit().putString(KEY, value).apply() }
        override fun apply(choice: String) = applyLocales(context, choice)
    }

    fun saved(context: Context): String = AppTarget(context).saved

    /** Keeps a new choice and, on Android 13+, makes the app's own screens follow it. Returns whether it changed. */
    fun choose(context: Context, value: String?): Boolean = choose(AppTarget(context), value)

    /**
     * Only a change is applied. The board repeats its choice every time it
     * opens; applying it again would put back the app's language over one the
     * person picked since in Android's own settings (Settings, Apps, Automa,
     * Language), which lists the app because of its localeConfig.
     */
    internal fun choose(target: Target, value: String?): Boolean {
        val choice = normalize(value) ?: return false
        if (target.saved == choice) return false
        target.saved = choice
        target.apply(choice)
        return true
    }

    /** The locales Android should use for the app: none (the phone's) for Auto. */
    fun localesFor(choice: String): LocaleList =
        if (choice == AUTO) LocaleList.getEmptyLocaleList() else LocaleList.forLanguageTags(choice)

    private fun applyLocales(context: Context, choice: String) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val manager = context.getSystemService(LocaleManager::class.java) ?: return
        val wanted = localesFor(choice)
        // Setting the same list again would still restart the configuration; only a change is applied.
        if (manager.applicationLocales.toLanguageTags() != wanted.toLanguageTags()) manager.applicationLocales = wanted
    }
}
