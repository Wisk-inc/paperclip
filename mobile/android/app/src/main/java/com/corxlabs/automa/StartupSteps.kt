package com.corxlabs.automa

/**
 * The step a starting Automa is on, in the app's language. The server names
 * its steps in English ("Checking assigned tasks"); res/values/startup_steps.xml
 * lists those names and each language's startup_steps.xml how the step reads
 * after "Now:" (made by mobile/android/scripts/sync-translations.mjs). A step
 * the app does not know yet (a newer server) reads in English, lowered as in
 * a sentence.
 */
internal object StartupSteps {
    fun name(label: String, labels: Array<String>, names: Array<String>): String {
        val index = labels.indexOf(label)
        return if (index >= 0 && index < names.size && names[index].isNotBlank()) names[index]
        else label.replaceFirstChar { it.lowercaseChar() }
    }
}
