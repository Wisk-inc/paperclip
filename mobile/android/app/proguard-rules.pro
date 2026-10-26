# R8 hardening for the shipped APK.
#
# The source in this repo stays readable: these rules only change the compiled
# DEX. R8 renames every class, method and field it can to short names, drops
# unused code, and (with the rules below) flattens the package tree and strips
# release logging, so decompiling the APK yields little that helps reverse
# engineering or lifting the app's code. Only names the Android framework or
# the WebView resolve by string are kept.

# -- Rename and relocate as aggressively as R8 allows --------------------------
# Move every obfuscated class into a single unnamed package (no package tree to
# read), and let R8 widen access so it can merge and inline more.
-repackageclasses ''
-allowaccessmodification

# Keep source-file/line attributes out of the release so a decompiler can't show
# original file names, but keep a renamed stack map for valid stack traces.
-renamesourcefileattribute SourceFile
-keepattributes SourceFile,LineNumberTable

# -- Strip logging from the release build --------------------------------------
# Removes android.util.Log calls (and their string arguments) during
# optimization: less for a decompiler to read, and a smaller APK.
-assumenosideeffects class android.util.Log {
    public static *** v(...);
    public static *** d(...);
    public static *** i(...);
    public static *** w(...);
    public static *** e(...);
    public static *** wtf(...);
    public static *** println(...);
}

# -- Keeps the app genuinely needs ---------------------------------------------
# The WebView page calls these methods by name through addJavascriptInterface;
# their names must survive obfuscation (the class itself is still renamed).
-keepclassmembers class com.corxlabs.automa.AutomaBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface

# Application/Activity/Service entry points are named in AndroidManifest.xml, so
# the default manifest-aware rules already keep their names. Firebase, Credential
# Manager and other libraries ship their own consumer keep rules in their AARs.
