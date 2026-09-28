package com.corxlabs.automa

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.addCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.ServiceWorkerClientCompat
import androidx.webkit.ServiceWorkerControllerCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * The Automa Android app: one activity hosting the Automa board in a WebView.
 *
 * - First launch shows the bundled connect screen; afterwards the app opens
 *   straight into the Automa server you connected (on your computer, a cloud
 *   host, or Termux on this phone).
 * - The layout is edge-to-edge: system bar, display-cutout and keyboard
 *   insets pad the WebView, so content never sits under a status bar, a
 *   camera cutout, the gesture bar, or the on-screen keyboard, on any screen
 *   size, fold state, or orientation.
 * - Native pieces the web page cannot do on its own — picking files, saving
 *   downloads, receiving the share sheet, and reading a shared folder for
 *   agents — are bridged through [AutomaBridge].
 */
class MainActivity : ComponentActivity() {
    companion object {
        const val ACTION_OPEN_PATH = "com.corxlabs.automa.OPEN_PATH"
        const val ACTION_CHANGE_SERVER = "com.corxlabs.automa.CHANGE_SERVER"
        const val ASSETS_HOST = "appassets.androidplatform.net"
        const val ASSETS_ORIGIN = "https://$ASSETS_HOST"
        const val CONNECT_URL = "$ASSETS_ORIGIN/assets/connect/index.html"
        private const val SHARE_EVENT = "window.dispatchEvent(new Event('automa:incoming-shares'))"
        private const val CAMERA_CACHE_MAX_AGE_MS = 24L * 60 * 60 * 1000
        private const val SERVER_BUNDLE_NAME = "automa-server.tar.xz"
        private const val SERVER_BUNDLE_ASSET = "server/$SERVER_BUNDLE_NAME"
        private const val TERMUX_PACKAGE = "com.termux"
        private const val TERMUX_DOWNLOAD_URL = "https://f-droid.org/packages/com.termux/"

        /** Gap between the two beats of the success haptic on Android 10 and older. */
        private const val SUCCESS_BEAT_GAP_MS = 70L

        /** Saves `<a download>` blob links (exports) through the bridge; they have no URL a native download could fetch. */
        private const val DOWNLOAD_HOOK = """
(function () {
  if (window.__automaDownloadHook) return;
  window.__automaDownloadHook = true;
  function save(href, name) {
    fetch(href).then(function (r) { return r.blob(); }).then(function (blob) {
      var reader = new FileReader();
      reader.onload = function () {
        var data = String(reader.result || '');
        if (window.AutomaNative) window.AutomaNative.saveBase64(name || 'download', blob.type || 'application/octet-stream', data.slice(data.indexOf(',') + 1));
      };
      reader.readAsDataURL(blob);
    });
  }
  var click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.href && this.href.indexOf('blob:') === 0 && this.hasAttribute('download')) { save(this.href, this.getAttribute('download')); return; }
    return click.apply(this, arguments);
  };
  document.addEventListener('click', function (event) {
    var anchor = event.target && event.target.closest ? event.target.closest('a[download]') : null;
    if (anchor && anchor.href && anchor.href.indexOf('blob:') === 0) { event.preventDefault(); save(anchor.href, anchor.getAttribute('download')); }
  }, true);
})();
"""
    }

    private lateinit var root: FrameLayout
    private lateinit var webView: WebView
    private lateinit var config: ServerConfig
    private lateinit var sharedFolder: SharedFolder
    private lateinit var incoming: IncomingShares
    private lateinit var bridge: AutomaBridge
    private lateinit var bundledUi: BundledUi
    private lateinit var googleSignIn: GoogleSignIn
    private lateinit var assetLoader: WebViewAssetLoader
    private val executor: ExecutorService = Executors.newFixedThreadPool(2)

    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingFolderCall: String? = null
    private var downloadHookInstalled = false

    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) Push.refreshToken(this)
    }

    private val fileChooser = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val callback = fileCallback ?: return@registerForActivityResult
        fileCallback = null
        val photo = cameraPhoto
        cameraPhoto = null
        val data = result.data
        val clip = data?.clipData
        val uris: Array<Uri>? = when {
            result.resultCode != RESULT_OK -> null
            // The camera app wrote the picture into the file we handed it.
            photo != null && photo.first.length() > 0 -> arrayOf(photo.second)
            clip != null && clip.itemCount > 0 -> Array(clip.itemCount) { clip.getItemAt(it).uri }
            else -> data?.data?.let { arrayOf(it) }
        }
        callback.onReceiveValue(uris)
    }

    /** The file and content URI a "Take photo" pick writes into, while the camera is open. */
    private var cameraPhoto: Pair<File, Uri>? = null

    private val folderPicker = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        val callId = pendingFolderCall ?: return@registerForActivityResult
        pendingFolderCall = null
        if (uri == null) {
            bridge.resolve(callId, JSONObject().put("ok", false).put("error", "No folder was chosen").toString())
            return@registerForActivityResult
        }
        executor.execute {
            val reply = try {
                sharedFolder.select(uri)
                JSONObject().put("ok", true).put("name", sharedFolder.name ?: "Shared folder").toString()
            } catch (error: SecurityException) {
                JSONObject().put("ok", false).put("error", "Android did not grant access to that folder").toString()
            }
            bridge.resolve(callId, reply)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)

        config = ServerConfig(this)
        sharedFolder = SharedFolder(this)
        incoming = IncomingShares(this)
        assetLoader = WebViewAssetLoader.Builder()
            .setDomain(ASSETS_HOST)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        setContentView(root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }

        googleSignIn = GoogleSignIn(this)
        bridge = AutomaBridge(this, config, sharedFolder, incoming, executor, googleSignIn)
        bundledUi = BundledUi(this)
        installWebView()
        installServiceWorkerInterception()

        onBackPressedDispatcher.addCallback(this) {
            if (webView.canGoBack()) {
                webView.goBack()
            } else {
                isEnabled = false
                onBackPressedDispatcher.onBackPressed()
                isEnabled = true
            }
        }

        if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null) {
            route(intent)
        } else if (incoming.isShareIntent(intent)) {
            route(intent)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        route(intent)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onPause() {
        webView.onPause()
        CookieManager.getInstance().flush()
        super.onPause()
    }

    override fun onDestroy() {
        executor.shutdown()
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
        super.onDestroy()
    }

    // ─── Navigation ────────────────────────────────────────────────────────

    private fun route(intent: Intent?) {
        when {
            intent?.action == ACTION_CHANGE_SERVER -> showConnect(null)
            incoming.isShareIntent(intent) -> {
                val shareIntent = intent!!
                executor.execute {
                    val added = incoming.accept(shareIntent)
                    runOnUiThread {
                        if (config.serverUrl == null) {
                            showConnect("Connect to your Automa server first. Your shared file${if (added == 1) " is" else "s are"} waiting on the Files page.")
                        } else {
                            openPath("/device-files")
                        }
                    }
                }
            }
            intent?.action == ACTION_OPEN_PATH -> openPath(intent.data?.schemeSpecificPart ?: "/")
            // A push notification tapped while the app was in the background.
            intent?.getStringExtra(Push.PATH_KEY) != null -> openPath(intent.getStringExtra(Push.PATH_KEY) ?: "/")
            else -> loadServer()
        }
    }

    fun loadServer() {
        val url = config.serverUrl
        if (url == null || googleSignIn.needsSignIn) showConnect(null) else webView.loadUrl(url)
    }

    private fun openPath(path: String) {
        val server = config.serverUrl ?: return showConnect(null)
        if (googleSignIn.needsSignIn) return showConnect(null)
        val safePath = if (path.startsWith("/") && !path.startsWith("//")) path else "/"
        webView.loadUrl(server + safePath)
    }

    fun showConnect(error: String?) {
        val suffix = error?.let { "?error=" + Uri.encode(it) } ?: ""
        webView.loadUrl(CONNECT_URL + suffix)
    }

    fun evaluate(script: String) {
        webView.evaluateJavascript(script, null)
    }

    fun pickFolder(callId: String) {
        pendingFolderCall?.let { bridge.resolve(it, JSONObject().put("ok", false).put("error", "Replaced by a newer request").toString()) }
        pendingFolderCall = callId
        try {
            folderPicker.launch(null)
        } catch (error: ActivityNotFoundException) {
            pendingFolderCall = null
            bridge.resolve(callId, JSONObject().put("ok", false).put("error", "This device has no folder picker").toString())
        }
    }

    /**
     * Page haptics (see ui/src/lib/haptics.ts). Uses the view's haptic
     * feedback, so the phone's touch-feedback setting is respected and no
     * VIBRATE permission is needed.
     */
    fun performHaptic(kind: String) {
        val modern = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
        when (kind) {
            "tick" -> webView.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
            "thud" -> webView.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
            "warning" -> webView.performHapticFeedback(
                if (modern) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS,
            )
            "success" -> if (modern) {
                webView.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
            } else {
                webView.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
                webView.postDelayed({ webView.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY) }, SUCCESS_BEAT_GAP_MS)
            }
        }
    }

    fun isTermuxInstalled(): Boolean = runCatching {
        packageManager.getPackageInfo(TERMUX_PACKAGE, 0)
        true
    }.getOrDefault(false)

    fun openTermux() {
        val launch = packageManager.getLaunchIntentForPackage(TERMUX_PACKAGE)
        if (launch != null) {
            startActivity(launch)
        } else {
            openExternal(Uri.parse(TERMUX_DOWNLOAD_URL))
        }
    }

    fun hasServerBundle(): Boolean = runCatching { assets.open(SERVER_BUNDLE_ASSET).close(); true }.getOrDefault(false)

    /**
     * Copies the server bundle out of the APK and shares it to Termux. Termux's
     * file receiver asks where to keep it; "Open directory" saves it as
     * ~/downloads/automa-server.tar.xz and opens a terminal there.
     */
    fun sendServerToTermux(done: (Result<Unit>) -> Unit) {
        if (!isTermuxInstalled()) {
            done(Result.failure(IllegalStateException("Install Termux first.")))
            return
        }
        executor.execute {
            val shared = runCatching {
                val dir = File(cacheDir, "server").apply { mkdirs() }
                val file = File(dir, SERVER_BUNDLE_NAME)
                assets.open(SERVER_BUNDLE_ASSET).use { input -> file.outputStream().use { input.copyTo(it) } }
                FileProvider.getUriForFile(this, "$packageName.files", file)
            }
            runOnUiThread {
                val result = shared.mapCatching { uri ->
                    val send = Intent(Intent.ACTION_SEND)
                        .setType("application/x-xz")
                        .setPackage(TERMUX_PACKAGE)
                        .putExtra(Intent.EXTRA_STREAM, uri)
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    send.clipData = ClipData.newRawUri(SERVER_BUNDLE_NAME, uri)
                    startActivity(send)
                }
                done(result)
            }
        }
    }

    fun copyToClipboard(text: String) {
        val clipboard = getSystemService(android.content.ClipboardManager::class.java) ?: return
        clipboard.setPrimaryClip(android.content.ClipData.newPlainText("Automa setup", text))
        // Android 13+ shows its own "copied" confirmation.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            Toast.makeText(this, R.string.copied, Toast.LENGTH_SHORT).show()
        }
    }

    /** Android 13+: ask once, after sign-in, so agents can reach this person. */
    fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == android.content.pm.PackageManager.PERMISSION_GRANTED) return
        notificationPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS)
    }

    fun applyTheme(dark: Boolean) {
        root.setBackgroundColor(if (dark) Color.BLACK else Color.WHITE)
        WindowCompat.getInsetsController(window, root).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
    }

    fun reportDownload(result: Downloads.Result) {
        runOnUiThread {
            val message = when {
                !result.ok -> getString(R.string.download_failed, result.filename)
                result.publicFolder -> getString(R.string.saved_to_downloads, result.filename)
                else -> getString(R.string.saved_to_app_downloads, result.filename)
            }
            Toast.makeText(this, message, Toast.LENGTH_LONG).show()
        }
    }

    private fun openExternal(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (error: ActivityNotFoundException) {
            Toast.makeText(this, R.string.no_app_for_link, Toast.LENGTH_SHORT).show()
        }
    }

    // ─── WebView ───────────────────────────────────────────────────────────

    private fun installWebView() {
        webView = createWebView()
        root.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(): WebView {
        val view = WebView(this)
        view.setBackgroundColor(Color.BLACK)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = true
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            useWideViewPort = true
            loadWithOverviewMode = true
            // Follow the system font size for accessibility.
            textZoom = (resources.configuration.fontScale * 100).toInt().coerceIn(85, 200)
            userAgentString = "$userAgentString AutomaAndroid/${BuildConfig.VERSION_NAME}"
        }
        // Native feel: no web scrollbars and no stretch/glow past the ends.
        view.isVerticalScrollBarEnabled = false
        view.isHorizontalScrollBarEnabled = false
        view.overScrollMode = View.OVER_SCROLL_NEVER
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            // Automa ships its own black theme; never let WebView recolor it.
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(view.settings, false)
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(view, false)
        }
        view.addJavascriptInterface(bridge, "AutomaNative")
        downloadHookInstalled = false
        config.serverOrigin()?.let { installDownloadHook(view, it) }

        view.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val url = request.url
                if (url.host == ASSETS_HOST) return assetLoader.shouldInterceptRequest(url)
                return bridge.intercept(url) ?: bundledUi.intercept(request, config.serverOrigin())
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (url.scheme == "https" && url.host == ASSETS_HOST) return false
                if (config.isServerUrl(url)) return false
                openExternal(url)
                return true
            }

            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                bridge.pageOrigin = ServerConfig.originOf(Uri.parse(url))
                if (!downloadHookInstalled) config.serverOrigin()?.let { installDownloadHook(view, it) }
            }

            override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
                bridge.pageOrigin = ServerConfig.originOf(Uri.parse(url))
            }

            override fun onPageFinished(view: WebView, url: String) {
                val origin = ServerConfig.originOf(Uri.parse(url))
                if (origin != null && origin == config.serverOrigin()) {
                    // Idempotent (guarded by a window flag); covers the first page after connecting.
                    view.evaluateJavascript(DOWNLOAD_HOOK, null)
                    if (!incoming.isEmpty()) view.evaluateJavascript(SHARE_EVENT, null)
                }
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame && config.isServerUrl(request.url)) {
                    showConnect("Could not reach ${request.url.host}. ${error.description}")
                }
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                // The renderer crashed or was reclaimed: rebuild instead of taking the app down.
                root.removeView(webView)
                webView.destroy()
                installWebView()
                loadServer()
                return true
            }
        }

        view.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams,
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = filePathCallback
                val pick = runCatching { fileChooserParams.createIntent() }.getOrNull()
                    ?: Intent(Intent.ACTION_GET_CONTENT).setType("*/*")
                pick.addCategory(Intent.CATEGORY_OPENABLE)
                if (fileChooserParams.mode == FileChooserParams.MODE_OPEN_MULTIPLE) pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                val chooser = Intent.createChooser(pick, getString(R.string.choose_file))
                cameraCaptureIntent(fileChooserParams)?.let { chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, arrayOf(it)) }
                return try {
                    fileChooser.launch(chooser)
                    true
                } catch (error: ActivityNotFoundException) {
                    fileCallback = null
                    cameraPhoto = null
                    false
                }
            }

            override fun onPermissionRequest(request: PermissionRequest) {
                request.deny() // no camera or microphone access from pages
            }

            override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
                callback.invoke(origin, false, false)
            }
        }

        view.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            val filename = Downloads.filenameFor(url, contentDisposition, mimeType)
            when {
                // Install the hook first so this synthetic click is saved through the
                // bridge instead of re-entering the download listener.
                url.startsWith("blob:") -> view.evaluateJavascript(
                    DOWNLOAD_HOOK + "(function(){var a=document.createElement('a');a.href=${JSONObject.quote(url)};a.download=${JSONObject.quote(filename)};a.click();})()",
                    null,
                )
                url.startsWith("data:") -> executor.execute { reportDownload(Downloads.saveDataUrl(this, url, filename)) }
                config.isServerUrl(Uri.parse(url)) -> executor.execute {
                    reportDownload(Downloads.fetch(this, url, userAgent, contentDisposition, mimeType))
                }
                else -> openExternal(Uri.parse(url))
            }
        }
        return view
    }

    /**
     * A "Take photo" entry for the attach picker when the page accepts images.
     * The camera app writes into a file in this app's cache through the
     * FileProvider, so Automa itself never needs the camera permission.
     */
    private fun cameraCaptureIntent(params: WebChromeClient.FileChooserParams): Intent? {
        val types = params.acceptTypes.orEmpty().map { it.trim().lowercase() }.filter { it.isNotEmpty() }
        val acceptsImages = types.isEmpty() || types.any {
            it == "*/*" || it.startsWith("image/") || it in setOf(".jpg", ".jpeg", ".png", ".heic", ".webp")
        }
        if (!acceptsImages) return null
        val capture = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
        if (capture.resolveActivity(packageManager) == null) return null
        return runCatching {
            val dir = File(cacheDir, "camera").apply { mkdirs() }
            // Photos from earlier chats were uploaded long ago; keep the cache small.
            val stale = System.currentTimeMillis() - CAMERA_CACHE_MAX_AGE_MS
            dir.listFiles()?.filter { it.lastModified() < stale }?.forEach { it.delete() }
            val file = File(dir, "photo-${System.currentTimeMillis()}.jpg")
            val uri = FileProvider.getUriForFile(this, "$packageName.files", file)
            cameraPhoto = file to uri
            capture.putExtra(MediaStore.EXTRA_OUTPUT, uri)
                .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
                .also { it.clipData = ClipData.newRawUri("photo", uri) }
        }.getOrNull()
    }

    private fun installDownloadHook(view: WebView, origin: String) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
        runCatching {
            WebViewCompat.addDocumentStartJavaScript(view, DOWNLOAD_HOOK, setOf(origin))
            downloadHookInstalled = true
        }
    }

    private fun installServiceWorkerInterception() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_BASIC_USAGE)) return
        ServiceWorkerControllerCompat.getInstance().setServiceWorkerClient(object : ServiceWorkerClientCompat() {
            override fun shouldInterceptRequest(request: WebResourceRequest): WebResourceResponse? =
                bridge.intercept(request.url) ?: bundledUi.intercept(request, config.serverOrigin())
        })
    }
}
