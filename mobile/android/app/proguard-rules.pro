# The page calls these methods by name through addJavascriptInterface.
-keepclassmembers class com.corxlabs.automa.AutomaBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface
