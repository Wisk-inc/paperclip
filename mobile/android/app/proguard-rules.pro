# The page calls these methods by name through addJavascriptInterface.
-keepclassmembers class app.automa.android.AutomaBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface
