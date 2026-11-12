package com.corxlabs.automa

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.MediaStore
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.webkit.MimeTypeMap
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
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.ScriptHandler
import androidx.webkit.ServiceWorkerClientCompat
import androidx.webkit.ServiceWorkerControllerCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.ByteArrayInputStream
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

        /** True while the board is in front of the person; news about finished work waits until they leave. */
        @Volatile
        var onScreen = false
            private set
        const val ACTION_CHANGE_SERVER = "com.corxlabs.automa.CHANGE_SERVER"
        /**
         * A server address on this phone's loopback, from the ADB helper
         * (`adb shell am start ... --es com.corxlabs.automa.CONNECT http://127.0.0.1:3100`
         * after `adb reverse`) or the Termux launcher. Anything that is not
         * loopback is ignored, and a new address or key waits for a tap on the
         * connect screen (see [connectRequested]).
         */
        const val EXTRA_CONNECT = "com.corxlabs.automa.CONNECT"
        /** The app key of a locked Automa on this phone (PAPERCLIP_LOCAL_TRUSTED_SECRET), with [EXTRA_CONNECT]. */
        const val EXTRA_SECRET = "com.corxlabs.automa.SECRET"
        /** The cookie a locked local Automa expects (server/src/middleware/local-trusted-secret.ts). */
        private const val SECRET_COOKIE = "paperclip_local_secret"
        /** Automa 1.0 shipped under this id; it installs beside, not over, this app. */
        private const val OLD_APP_PACKAGE = "app.automa.android"
        private const val PREF_OLD_APP_OFFERED = "oldAppRemovalOffered"
        const val ASSETS_HOST = "appassets.androidplatform.net"
        const val ASSETS_ORIGIN = "https://$ASSETS_HOST"
        const val CONNECT_PATH = "/assets/connect/index.html"
        const val CONNECT_URL = "$ASSETS_ORIGIN$CONNECT_PATH"
        private const val SHARE_EVENT = "window.dispatchEvent(new Event('automa:incoming-shares'))"
        /**
         * Tells the board its server answers again after it did not: the board
         * makes the requests that failed meanwhile again ("Failed to fetch"
         * stayed until the app was reopened). See ui/src/lib/connection-recovery.ts.
         */
        private const val SERVER_BACK_EVENT = "window.dispatchEvent(new Event('automa:server-back'))"
        private const val CAMERA_CACHE_MAX_AGE_MS = 24L * 60 * 60 * 1000
        private const val SERVER_BUNDLE_NAME = "automa-server.tar.xz"
        private const val SERVER_BUNDLE_ASSET = "server/$SERVER_BUNDLE_NAME"
        private const val TERMUX_PACKAGE = "com.termux"
        private const val TERMUX_RUN_COMMAND_PERMISSION = "com.termux.permission.RUN_COMMAND"
        private const val TERMUX_RUN_COMMAND_ACTION = "com.termux.RUN_COMMAND"
        private const val TERMUX_RUN_COMMAND_SERVICE = "com.termux.app.RunCommandService"
        private const val PREF_TERMUX_REFUSED = "refused_external_apps"

        /**
         * Pasted into Termux, this turns on allow-external-apps (replacing a
         * "false" line if there is one) and reloads Termux's settings.
         */
        const val TERMUX_ALLOW_EXTERNAL_APPS_FIX =
            "mkdir -p ~/.termux && touch ~/.termux/termux.properties && " +
                "sed -i '/^[[:space:]]*allow-external-apps/d' ~/.termux/termux.properties && " +
                "echo 'allow-external-apps = true' >> ~/.termux/termux.properties && " +
                "termux-reload-settings && echo 'Done. Go back to Automa and tap Try again.'"
        // Termux's own files, which RUN_COMMAND names by absolute path; they are
        // not in this app's storage, so getFilesDir() can't stand in for them.
        @SuppressLint("SdCardPath")
        private const val TERMUX_AUTOMA_PATH = "/data/data/com.termux/files/usr/bin/automa"
        @SuppressLint("SdCardPath")
        private const val TERMUX_HOME = "/data/data/com.termux/files/home"
        /** The bundle Termux puts a command's result in, and its "no error" value. */
        private const val TERMUX_RESULT_BUNDLE = "result"
        private const val TERMUX_ERRNO_SUCCESS = -1
        private const val TERMUX_REPLY_TIMEOUT_MS = 20_000L
        private const val TERMUX_DOWNLOAD_URL = "https://f-droid.org/packages/com.termux/"

        /** Gap between the two beats of the success haptic on Android 10 and older. */
        private const val SUCCESS_BEAT_GAP_MS = 70L
        /** How long the connect screen's success panel shows before Automa opens. */
        const val CONNECTED_SCREEN_MS = 1900L
        /** Asks the board to close an open drawer, sheet or dialog; "true" when it did (see Layout.tsx). */
        private const val CLOSE_OVERLAY_SCRIPT =
            "(function(){try{return window.__automaCloseOverlay?String(window.__automaCloseOverlay()):'false'}catch(e){return 'false'}})()"
        /** Shown on the connect screen when the board reported the key missing and nothing the app holds works. */
        private const val KEY_SHARE_HANDLED = "automa.shareHandled"
        /** How long after a connect request the waiting screen leaves starting Automa to Termux. */
        private const val CONNECT_REQUEST_START_WINDOW_MS = 2 * 60_000L
        /**
         * How many times in a row Automa on this phone may not answer before the
         * connect screen waits for it (and asks Termux to start it). One missed
         * answer is often Android pausing Termux for a moment, or Automa
         * restarting after an update: the page stays and is checked again.
         */
        private const val LOOPBACK_CHECKS_BEFORE_WAIT = 3
        private const val LOOPBACK_RECHECK_MS = 2_500L
        /** Automa answered that it is still starting: checked again this often. */
        private const val STARTING_RECHECK_MS = 4_000L

        const val LOCKED_WITHOUT_KEY = "Automa on this phone is locked to the app, and the app does not have its key. In Termux, run: automa link (it opens Automa here). You can also paste the key it prints."

        /**
         * The server at [url] didn't prove it holds the app key (a wrong key,
         * or another program on its port), so the key was not sent.
         */
        fun unprovenServerMessage(url: String): String {
            val uri = Uri.parse(url)
            val address = if (uri.port != -1) "${uri.host}:${uri.port}" else uri.host ?: url
            return "The Automa at $address didn't accept this app's key, so the app kept the key to itself. " +
                "In Termux, run: automa link. If another app is using $address, close it and start Automa again."
        }

        /**
         * The part of a board URL worth coming back to: path, query and hash.
         * Transient pages (the onboarding wizard, sign-in) are not remembered.
         */
        fun rememberablePath(uri: Uri): String? {
            val path = uri.path?.takeIf { it.isNotEmpty() && it != "/" } ?: return null
            if (!isBoardPath(path)) return null
            if (path.endsWith("/onboarding") || path.startsWith("/login") || path.startsWith("/auth")) return null
            val query = uri.encodedQuery?.let { "?$it" } ?: ""
            val fragment = uri.encodedFragment?.let { "#$it" } ?: ""
            return uri.encodedPath + query + fragment
        }

        /**
         * A page of the board itself, not an API reply, a raw file or a Studio
         * preview: only those are remembered or opened from other apps. A
         * remembered "/api/…" page opened as raw JSON on every launch.
         */
        fun isBoardPath(path: String): Boolean {
            if (!path.startsWith("/") || path.startsWith("//")) return false
            val blocked = listOf("/api/", "/_plugins/", "/mcp/", "/.well-known/", "/assets/")
            return path != "/api" && blocked.none { path.startsWith(it) }
        }

        /** Saves `<a download>` blob links (exports) through the bridge; they have no URL a native download could fetch. */
        private const val DOWNLOAD_HOOK = """
(function () {
  if (window.__automaDownloadHook) return;
  window.__automaDownloadHook = true;
  function base64Of(part) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { var data = String(reader.result || ''); resolve(data.slice(data.indexOf(',') + 1)); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsDataURL(part);
    });
  }
  // Sent in 512 KB pieces: one base64 string of a large export ran the app
  // out of memory.
  function save(href, name) {
    saveNow(href, name).catch(function () {});
  }
  async function saveNow(href, name) {
    var native = window.AutomaNative;
    if (!native) return;
    var key = window.__automaKey || '';
    var blob = await (await fetch(href)).blob();
    var type = blob.type || 'application/octet-stream';
    var id = native.beginDownload ? native.beginDownload(key, name || 'download', type) : '';
    if (!id) {
      native.saveBase64(key, name || 'download', type, await base64Of(blob));
      return;
    }
    var size = 512 * 1024;
    try {
      for (var offset = 0; offset < blob.size; offset += size) {
        if (!native.appendDownload(key, id, await base64Of(blob.slice(offset, offset + size)))) return;
      }
      native.finishDownload(key, id);
    } catch (error) {
      native.cancelDownload(key, id);
    }
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
    private var pageKeyHandler: ScriptHandler? = null
    private var pageKeyOrigins: Set<String> = emptySet()
    private var pendingFolderCall: String? = null
    /** Where a notification or shortcut was going when the app first had to sign in. */
    private var pendingPath: String? = null
    /** The organization the folder being picked is shared with (null from pages older than 1.9.6). */
    private var pendingFolderCompany: String? = null
    private var downloadHookInstalled = false
    /** How many times the board reported a missing key since the last successful connect. */
    private var keyRecoveryAttempts = 0

    /** A proof of the server's key is on its way (see [proveThenLoad]). */
    private var proving = false

    /** Servers on this phone that answered they need no key, this run. */
    private val unlockedOrigins = mutableSetOf<String>()

    /** True while the connect screen is waiting for this phone's Automa to answer (see showConnect). */
    var waitingForServer = false
        private set

    /**
     * When the last connect request arrived (Termux's `automa run` or `automa
     * link` sends one as it starts Automa). Shortly after one, the waiting
     * screen does not ask Termux to start Automa again: it is starting.
     */
    private var connectRequestedAt = 0L

    fun connectRequestedRecently(): Boolean =
        connectRequestedAt != 0L && SystemClock.elapsedRealtime() - connectRequestedAt < CONNECT_REQUEST_START_WINDOW_MS

    private var offlineOverlay: ConnectionOverlay? = null
    /**
     * The server did not answer since its last answer, or the network went:
     * requests the board made meanwhile may have failed, so it is told when
     * the server answers again (see [SERVER_BACK_EVENT]).
     */
    private var serverAway = false
    private var mainFrameFailures = 0
    /** Health checks in a row that Automa on this phone did not answer (see confirmServerAnswers). */
    private var healthFailures = 0
    /** A health check is on its way; another is not started until it answers. */
    private var healthCheckPending = false
    /** The next health check, when one is scheduled (see scheduleHealthCheck). */
    private var scheduledHealthCheck: Runnable? = null
    /** The page failed to load while the server was away: loaded again once it answers. */
    private var reloadWhenServerAnswers = false
    /** Proof requests in a row that could not reach the server (see proveThenLoad). */
    private var proofFailures = 0
    /** The next proof request, when one is scheduled (see proveThenLoad). */
    private var scheduledProof: Runnable? = null
    /** Delayed checks of this phone's server; all dropped when the activity goes. */
    private val checks = Handler(Looper.getMainLooper())
    /** When a connector's sign-in began running in the app (see [SignInLinks]); 0 when none is. */
    private var signInStartedAt = 0L
    private var signInBar: SignInBar? = null
    /** Set when the connect screen is shown: the board page that follows drops it from Back history. */
    private var clearHistoryOnServerPage = false
    private val connectivity: ConnectivityManager? by lazy { getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager }
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            // A network came back: any connection sheet tries again now (a server
            // that could not be reached may answer on the new network too), and
            // an open board whose server went away is checked, so the moment it
            // answers the board makes its failed requests again.
            runOnUiThread {
                when {
                    offlineOverlay != null -> retryServer()
                    serverAway && onServerPage() -> confirmServerAnswers()
                }
            }
        }
        override fun onLost(network: Network) {
            runOnUiThread {
                val server = config.serverUrl ?: return@runOnUiThread
                // A server on this phone does not need the network; only a remote one goes offline.
                if (ServerConfig.isLoopback(server) || !onServerPage()) return@runOnUiThread
                serverAway = true
                if (connectivity?.activeNetwork == null) showOffline(ConnectionOverlay.Reason.OFFLINE, null)
            }
        }
    }

    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) Push.refreshToken(this)
    }

    /** Waiting on Android's "Allow Automa to run commands in Termux?" answer. */
    private var termuxStartAfterPermission: ((JSONObject) -> Unit)? = null
    private var termuxRequestCode = 0
    private val termuxRunPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val done = termuxStartAfterPermission ?: return@registerForActivityResult
        termuxStartAfterPermission = null
        if (granted) {
            launchAutomaInTermux(done)
        } else {
            done(
                termuxFailure(
                    "denied",
                    "Automa can't start it for you without that permission. Open Termux and run: automa run",
                ),
            )
        }
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
        val company = pendingFolderCompany
        pendingFolderCompany = null
        val origin = config.serverOrigin()
        if (uri == null) {
            bridge.resolve(callId, JSONObject().put("ok", false).put("error", "No folder was chosen").toString())
            return@registerForActivityResult
        }
        executor.execute {
            val reply = try {
                sharedFolder.select(uri, origin, company)
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
        bundledUi = BundledUi(this, bridge.pageKey)
        installWebView()
        installServiceWorkerInterception()

        onBackPressedDispatcher.addCallback(this) {
            // Whatever is on top of the page (the drawer, a sheet, a dialog)
            // closes first; only a bare page goes back in history.
            val callback = this
            webView.evaluateJavascript(CLOSE_OVERLAY_SCRIPT) { result ->
                if (result == "\"true\"") return@evaluateJavascript
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    callback.isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                    callback.isEnabled = true
                }
            }
        }

        offerOldAppRemoval()

        // Reopened from Recents, Android hands back the launch that started this
        // task (a share, a notification, Change server): that already happened,
        // so the board opens as it was instead of doing it again.
        val fromHistory = (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0
        val server = config.serverUrl
        when {
            savedInstanceState == null -> if (fromHistory) loadServer() else route(intent)
            // Back after Android ended the app's process (memory): the server
            // proves it holds the app key again before the key goes to it, then
            // the page the person was on opens (loadServer remembers it).
            server != null && (keyAwaitsProof(server) || googleSignIn.needsSignIn) -> loadServer()
            else -> {
                // The page key goes in before the restored page's scripts run,
                // or the board could not reach the phone until its next full load.
                installPageKey()
                applyServerCookie()
                if (webView.restoreState(savedInstanceState) == null) {
                    // Nothing to restore: the last page, never the launch that
                    // started this task again (Change server showed the connect
                    // screen over a board that was fine).
                    loadServer()
                } else if (!fromHistory && incoming.isShareIntent(intent) && !savedInstanceState.getBoolean(KEY_SHARE_HANDLED)) {
                    route(intent)
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        route(intent, reopened = true)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
        // The activity's intent is routed as soon as it arrives; after process
        // death Android hands the same share back, which must not import twice.
        if (incoming.isShareIntent(intent)) outState.putBoolean(KEY_SHARE_HANDLED, true)
    }

    override fun onStart() {
        super.onStart()
        runCatching { connectivity?.registerDefaultNetworkCallback(networkCallback) }
    }

    override fun onStop() {
        runCatching { connectivity?.unregisterNetworkCallback(networkCallback) }
        super.onStop()
    }

    private fun textZoomFor(configuration: Configuration) = (configuration.fontScale * 100).toInt().coerceIn(85, 200)

    // The manifest keeps the activity on a font size change (fontScale is in
    // configChanges), so the WebView's text zoom is updated here; it was set
    // only at creation and the new size showed after a restart.
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        if (::webView.isInitialized) {
            val zoom = textZoomFor(newConfig)
            if (webView.settings.textZoom != zoom) webView.settings.textZoom = zoom
        }
    }

    override fun onResume() {
        super.onResume()
        onScreen = true
        webView.onResume()
        // A sheet left waiting on this phone's server picks its checks up again,
        // and a board whose server went away while the app was away is checked
        // (it hears the moment the server answers, see SERVER_BACK_EVENT).
        val waitingSheet = offlineOverlay?.reason
        if (waitingSheet != null && waitingSheet != ConnectionOverlay.Reason.OFFLINE) confirmServerAnswers()
        else if (waitingSheet == null && serverAway && onServerPage()) confirmServerAnswers()
    }

    override fun onPause() {
        onScreen = false
        // Off screen the server is not checked (onResume picks the sheet's checks
        // up again); a proof on its way still finishes, so the board is there on return.
        scheduledHealthCheck?.let { checks.removeCallbacks(it) }
        scheduledHealthCheck = null
        webView.onPause()
        CookieManager.getInstance().flush()
        super.onPause()
    }

    override fun onDestroy() {
        cancelScheduledChecks()
        executor.shutdown()
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
        super.onDestroy()
    }

    // ─── Navigation ────────────────────────────────────────────────────────

    /** [reopened]: the intent reached the running activity (singleTask delivers every launch there). */
    private fun route(intent: Intent?, reopened: Boolean = false) {
        when {
            intent?.action == ACTION_CHANGE_SERVER -> showConnect(null)
            incoming.isShareIntent(intent) -> {
                val shareIntent = intent!!
                executor.execute {
                    // A sending app's malformed extras must not end Automa on this worker thread.
                    val added = runCatching { incoming.accept(shareIntent) }.getOrDefault(0)
                    runOnUiThread {
                        if (added == 0) {
                            // A file:// link (refused) or content Android wouldn't hand over.
                            Toast.makeText(this, R.string.share_unreadable, Toast.LENGTH_LONG).show()
                            if (webView.url == null) loadServer()
                        } else if (config.serverUrl == null) {
                            showConnect("Connect to your Automa server first. Your shared file${if (added == 1) " is" else "s are"} waiting on the Files page.")
                        } else {
                            openPath("/device-files")
                        }
                    }
                }
            }
            intent?.getStringExtra(EXTRA_CONNECT) != null ->
                connectRequested(intent.getStringExtra(EXTRA_CONNECT) ?: "", intent.getStringExtra(EXTRA_SECRET))
            intent?.action == ACTION_OPEN_PATH -> {
                val path = intent.data?.schemeSpecificPart ?: "/"
                val origin = intent.getStringExtra(Push.ORIGIN_KEY)
                if (origin == null || origin == config.serverOrigin()) {
                    openPath(path)
                } else {
                    // News from another saved server: open it there, not on the current one.
                    val saved = config.savedUrlFor(origin)
                    if (saved != null) {
                        config.remember(saved)
                        openPath(path)
                    } else {
                        loadServer()
                    }
                }
            }
            // A push notification tapped while the app was in the background.
            intent?.getStringExtra(Push.PATH_KEY) != null -> openPath(intent.getStringExtra(Push.PATH_KEY) ?: "/")
            // The launcher icon tapped while Automa is open: the page stays as it
            // is, since a reload loses whatever was typed or open on it.
            reopened && webView.url != null -> Unit
            else -> loadServer()
        }
    }

    /**
     * A connect request from another app (Termux's launcher, or the ADB helper
     * through `am start`). Only loopback addresses count, and only an address
     * and key the app already has is applied by itself: anything new waits on
     * the connect screen for a tap, so no app can quietly point Automa at a
     * server of its own and collect the sign-in that follows.
     */
    private fun connectRequested(input: String, secret: String?) {
        val url = ServerConfig.normalize(input)
        if (url == null || !ServerConfig.isLoopback(url)) return loadServer()
        connectRequestedAt = SystemClock.elapsedRealtime()
        val origin = ServerConfig.originOf(Uri.parse(url))
        val appKey = secret?.trim()?.takeIf { it.length in ServerConfig.MIN_SECRET_LENGTH..ServerConfig.MAX_SECRET_LENGTH }
        val knownServer = config.serverUrl == url
        val knownKey = appKey == null || (origin != null && config.secretFor(origin) == appKey)
        if (knownServer && knownKey) {
            // Termux sends this each time automa run starts Automa. With the board
            // already open on it, the page stays (a reload lost what was typed,
            // and landed on the connect screen while Automa was still starting);
            // the server is checked instead, and the sheet covers its start.
            if (onServerPage()) return confirmServerAnswers()
            // The connect screen open: it waits for Automa right there, its steps
            // carrying on (reloading it started them over from the top each time
            // Termux sent this), and leaves starting Automa to Termux.
            if (onConnectPage()) {
                val hook = "(function(){if(window.__automaConnectRequested){window.__automaConnectRequested(${JSONObject.quote(url)});return 'waiting'}return 'no'})()"
                webView.evaluateJavascript(hook) { result -> if (result != "\"waiting\"") loadServer() }
                return
            }
            return loadServer()
        }
        config.pendingConnect = ServerConfig.PendingConnect(url, appKey)
        if (knownServer && appKey != null && origin != null) {
            // A new key for the server this phone already uses (Termux reinstalled,
            // or the key never reached the app): taken as soon as Automa accepts
            // it, with no tap. Not up yet: the connect screen waits for it and
            // opens Automa by itself, keeping the key for when it answers.
            executor.execute {
                // Checked by the server's proof: the key goes only to a server that holds it.
                val accepted = config.keyWorks(url, appKey)
                // Not taken while Automa is up and the key the app has still
                // works: the request was stray or forged (any app can send
                // one), and the person stays on the board.
                val storedWorks = !accepted && config.secretFor(origin)?.let { config.keyWorks(url, it) } == true
                runOnUiThread {
                    when {
                        accepted -> {
                            config.rememberSecret(origin, appKey)
                            config.pendingConnect = null
                            loadServer()
                        }
                        storedWorks -> {
                            config.pendingConnect = null
                            loadServer()
                        }
                        else -> showConnect(null, wait = true)
                    }
                }
            }
            return
        }
        showConnect(null)
    }

    /**
     * The board says this Automa is locked and its page arrived without the
     * key (LocalSecretNotice). Try the keys the app holds against the server
     * first: the cookie may simply not have been applied, or Termux handed a
     * key over that was never confirmed. Only when none works does the connect
     * screen ask for `automa link`.
     */
    fun recoverAppKey() {
        val url = config.serverUrl ?: return showConnect(null)
        val origin = ServerConfig.originOf(Uri.parse(url)) ?: return showConnect(null)
        val pending = config.pendingConnect?.takeIf { ServerConfig.originOf(Uri.parse(it.url)) == origin }?.secret
        val candidates = listOfNotNull(pending, config.secretFor(origin)).distinct()
        if (candidates.isEmpty() || keyRecoveryAttempts >= 2) {
            keyRecoveryAttempts = 0
            return showConnect(LOCKED_WITHOUT_KEY)
        }
        keyRecoveryAttempts += 1
        executor.execute {
            // Each key is checked by the server's proof, not by sending it.
            var working: String? = null
            var unanswered = false
            for (candidate in candidates) {
                when (config.verifyKey(url, candidate)) {
                    ServerConfig.KeyVerdict.WORKS -> working = candidate
                    ServerConfig.KeyVerdict.UNREACHABLE -> unanswered = true
                    ServerConfig.KeyVerdict.REJECTED -> continue
                }
                break
            }
            runOnUiThread {
                when {
                    working != null -> {
                        config.rememberSecret(origin, working)
                        if (working == pending) config.pendingConnect = null
                        loadServer()
                    }
                    // Automa did not answer the check (restarting, or still
                    // starting): that is no missing key. It is waited for.
                    unanswered -> {
                        keyRecoveryAttempts = 0
                        serverWentAway()
                        showConnect(null, wait = true)
                    }
                    else -> {
                        keyRecoveryAttempts = 0
                        showConnect(LOCKED_WITHOUT_KEY)
                    }
                }
            }
        }
    }

    /**
     * The connect screen reached [reachedUrl]: remember it, keep its app key,
     * and open it after [delayMs], which is how long the page's success screen
     * stays up (the board takes the rest of the trip, setup first on a fresh install).
     */
    fun finishConnect(reachedUrl: String, appKey: String?, delayMs: Long = 0) {
        val origin = ServerConfig.originOf(Uri.parse(reachedUrl))
        config.remember(reachedUrl)
        if (origin != null) {
            val pending = config.pendingConnect?.takeIf { ServerConfig.originOf(Uri.parse(it.url)) == origin }
            val secret = appKey ?: pending?.secret
            if (secret != null) config.rememberSecret(origin, secret)
            if (pending != null) config.pendingConnect = null
        }
        keyRecoveryAttempts = 0
        mainFrameFailures = 0
        if (delayMs > 0) webView.postDelayed({ loadServer() }, delayMs) else loadServer()
    }

    fun forgetServer(url: String) {
        ServerConfig.originOf(Uri.parse(url))?.let { origin ->
            config.forgetSecret(origin)
            clearServerCookie(origin)
            // A forgotten server keeps nothing of this phone's: not its shared
            // folder, and its notifications are no longer shown.
            if (sharedFolder.origin == origin) sharedFolder.clear()
            Push.forgetOrigin(this, origin)
        }
        config.forget(url)
    }

    fun loadServer() {
        val url = config.serverUrl
        if (url == null || googleSignIn.needsSignIn) return showConnect(null)
        // The app key goes only to a server that proved it holds it.
        if (keyAwaitsProof(url)) return proveThenLoad(url)
        waitingForServer = false
        hideOffline()
        installPageKey()
        applyServerCookie()
        // A notification or shortcut tapped before signing in goes first; otherwise
        // land where the person left off, or on a fresh server's own start page.
        val pending = pendingPath
        pendingPath = null
        val origin = config.serverOrigin()
        webView.loadUrl(if (pending != null && origin != null) origin + pending else lastPageUrl() ?: url)
    }

    /** The app holds a key for [url]'s server that the server has not proved it holds, this run. */
    private fun keyAwaitsProof(url: String): Boolean {
        val origin = ServerConfig.originOf(Uri.parse(url)) ?: return false
        val secret = config.secretFor(origin) ?: return false
        return origin !in unlockedOrigins && !ServerConfig.isKeyCleared(origin, secret)
    }

    /**
     * Has the server prove it holds the app key before any request carries
     * it (cookies go to whatever answers on that port), then loads the board.
     * Still starting: the connect screen waits for it. No proof: the key
     * stays in the app and the connect screen says why.
     */
    private fun proveThenLoad(url: String) {
        val origin = ServerConfig.originOf(Uri.parse(url)) ?: return
        val secret = config.secretFor(origin) ?: return
        clearServerCookie(origin)
        if (proving) return
        proving = true
        executor.execute {
            val check = config.clearKeyFor(url, secret)
            runOnUiThread {
                proving = false
                if (config.serverUrl != url) return@runOnUiThread
                when {
                    check.cleared -> {
                        proofFailures = 0
                        loadServer()
                    }
                    check.proof == ServerConfig.Proof.NOT_LOCKED -> {
                        // It needs no key: the board opens without one.
                        proofFailures = 0
                        unlockedOrigins.add(origin)
                        loadServer()
                    }
                    check.proof == ServerConfig.Proof.UNREACHABLE -> {
                        // Automa on this phone not answering for a moment (Termux paused
                        // by Android, a restart) is asked again before the connect
                        // screen waits for it, which also asks Termux to start it.
                        proofFailures += 1
                        if (ServerConfig.isLoopback(url) && proofFailures < LOOPBACK_CHECKS_BEFORE_WAIT) {
                            val again = Runnable {
                                scheduledProof = null
                                if (!isDestroyed && config.serverUrl == url && keyAwaitsProof(url)) proveThenLoad(url)
                            }
                            scheduledProof = again
                            checks.postDelayed(again, LOOPBACK_RECHECK_MS)
                        } else {
                            proofFailures = 0
                            showConnect(null, wait = true)
                        }
                    }
                    else -> {
                        proofFailures = 0
                        showConnect(unprovenServerMessage(url))
                    }
                }
            }
        }
    }

    /** This phone's Automa stopped answering: before its key goes out again, it proves itself again. */
    private fun serverWentAway() {
        val origin = config.serverOrigin() ?: return
        ServerConfig.forgetClearance(origin)
        unlockedOrigins.remove(origin)
        clearServerCookie(origin)
    }

    /** The page this phone was last on, as a full URL; the remembered path already carries any base path. */
    private fun lastPageUrl(): String? {
        val path = config.lastPath ?: return null
        val origin = config.serverOrigin() ?: return null
        return origin + path
    }

    /** Reloads the server page after a connection came back, keeping the current page. */
    private fun retryServer() {
        val url = config.serverUrl ?: return showConnect(null)
        if (keyAwaitsProof(url)) return proveThenLoad(url)
        hideOffline()
        installPageKey()
        applyServerCookie()
        val current = webView.url?.let(Uri::parse)
        when {
            // The page itself is fine (only the network went away): it
            // reconnects on its own, so a reload would just lose what was typed.
            // The server is still asked: if it doesn't answer, the sheet comes
            // back instead of Try now only hiding it.
            current != null && config.isServerUrl(current) &&
                (mainFrameFailures == 0 || offlineOverlay?.reason == ConnectionOverlay.Reason.STARTING) -> confirmServerAnswers()
            current != null && config.isServerUrl(current) -> webView.reload()
            else -> webView.loadUrl(lastPageUrl() ?: url)
        }
    }

    /**
     * The board ships inside the app, so its page always loads, even with the
     * server down; then it showed only "Failed to fetch". After each board
     * page load the server is checked, and an unreachable one gets the same
     * screens as a failed page load.
     *
     * Automa on this phone is checked a few times before the app gives up on
     * it: one slow or refused answer (Android paused Termux for a moment, or
     * Automa restarting after an update) sent the person straight back to the
     * connect screen, which then asked Termux to start an Automa that was
     * already up. One that answers it is still starting keeps the page, with
     * the "starting" sheet over it, until it is ready.
     *
     * [reloadWhenAnswering]: the page itself failed to load (onReceivedError);
     * it is loaded again once the server answers.
     */
    private fun confirmServerAnswers(reloadWhenAnswering: Boolean = false) {
        val server = config.serverUrl ?: return
        if (reloadWhenAnswering) reloadWhenServerAnswers = true
        scheduledHealthCheck?.let { checks.removeCallbacks(it) }
        scheduledHealthCheck = null
        if (healthCheckPending || isDestroyed) return
        healthCheckPending = true
        executor.execute {
            val health = ServerConfig.checkHealth(server)
            runOnUiThread {
                healthCheckPending = false
                if (isDestroyed || config.serverUrl != server) return@runOnUiThread
                // Only the server answering ends a run of failures (which sets the
                // retry wait): the bundled page loads even while the server is down.
                if (health.ok) {
                    val wasStarting = offlineOverlay?.reason == ConnectionOverlay.Reason.STARTING
                    val reload = reloadWhenServerAnswers || wasStarting
                    val wasAway = serverAway
                    reloadWhenServerAnswers = false
                    serverAway = false
                    healthFailures = 0
                    mainFrameFailures = 0
                    if (wasStarting) hideOffline()
                    // The page's own requests failed while the server was away or
                    // starting: loaded again now that it answers. A page that
                    // loaded fine is not reloaded (what was typed stays): it is
                    // told, and makes its failed requests again.
                    if (reload && onServerPage()) webView.reload()
                    else if (wasAway && onServerPage()) evaluate(SERVER_BACK_EVENT)
                    return@runOnUiThread
                }
                serverAway = true
                if (!onServerPage()) return@runOnUiThread
                mainFrameFailures += 1
                when {
                    ServerConfig.isLoopback(server) -> phoneServerNotAnswering(health)
                    connectivity?.activeNetwork == null -> showOffline(ConnectionOverlay.Reason.OFFLINE, null)
                    // Still no answer after a few tries: the connect screen, as a failed
                    // page load does, instead of retrying the sheet forever.
                    mainFrameFailures > 3 -> showConnect(ServerConfig.explain(server, health))
                    else -> showOffline(ConnectionOverlay.Reason.UNREACHABLE, ServerConfig.explain(server, health))
                }
            }
        }
    }

    /** Automa on this phone did not answer a health check: see [confirmServerAnswers]. */
    private fun phoneServerNotAnswering(health: ServerConfig.HealthResult) {
        when {
            // It answered that it is still starting (its database, or the recovery
            // after a restart): it is there, so the page stays and the sheet says
            // so until it is ready.
            health.kind == ServerConfig.HealthKind.UNHEALTHY -> {
                healthFailures = 0
                showOffline(ConnectionOverlay.Reason.STARTING, startingDetail(health.startup))
                scheduleHealthCheck(STARTING_RECHECK_MS)
            }
            // No answer at all: a moment of silence is checked again before the
            // connect screen, which asks Termux to start Automa.
            healthFailures + 1 < LOOPBACK_CHECKS_BEFORE_WAIT -> {
                healthFailures += 1
                scheduleHealthCheck(LOOPBACK_RECHECK_MS)
            }
            else -> {
                healthFailures = 0
                serverWentAway()
                showConnect(null, wait = true)
            }
        }
    }

    /** "Now: checking assigned tasks · 1 min 05 s so far", from what a starting Automa says (1.9.10 on). */
    private fun startingDetail(startup: ServerConfig.Startup?): String? {
        startup ?: return null
        val parts = listOfNotNull(
            startup.label?.let { getString(R.string.starting_step, it.replaceFirstChar { first -> first.lowercaseChar() }) },
            startup.seconds?.let { getString(R.string.starting_elapsed, formatSeconds(it)) },
        )
        return parts.takeIf { it.isNotEmpty() }?.joinToString(" · ")
    }

    private fun formatSeconds(seconds: Int): String =
        if (seconds < 60) getString(R.string.duration_seconds, seconds)
        else getString(R.string.duration_minutes, seconds / 60, seconds % 60)

    /** The next check of this phone's server, in [delayMs]; only while the app is on screen. */
    private fun scheduleHealthCheck(delayMs: Long) {
        scheduledHealthCheck?.let { checks.removeCallbacks(it) }
        if (!onScreen) return
        val check = Runnable {
            scheduledHealthCheck = null
            confirmServerAnswers()
        }
        scheduledHealthCheck = check
        checks.postDelayed(check, delayMs)
    }

    private fun cancelScheduledChecks() {
        scheduledHealthCheck?.let { checks.removeCallbacks(it) }
        scheduledHealthCheck = null
        scheduledProof?.let { checks.removeCallbacks(it) }
        scheduledProof = null
    }

    private fun onServerPage(): Boolean = webView.url?.let { config.isServerUrl(Uri.parse(it)) } == true

    private fun onConnectPage(): Boolean = webView.url?.startsWith(CONNECT_URL) == true

    /** The native "no connection" / "can't reach Automa" sheet over the page, with its retry countdown. */
    private fun showOffline(reason: ConnectionOverlay.Reason, detail: String?) {
        serverAway = true
        val overlay = offlineOverlay ?: ConnectionOverlay(this, onRetry = { retryServer() }, onOtherServer = {
            hideOffline()
            showConnect(null)
        }).also {
            offlineOverlay = it
            root.addView(it, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }
        val retryInSeconds = when (reason) {
            // Waiting on the network, or on the checks MainActivity schedules: no timer.
            ConnectionOverlay.Reason.OFFLINE, ConnectionOverlay.Reason.STARTING -> 0
            ConnectionOverlay.Reason.UNREACHABLE -> listOf(5, 10, 20).getOrElse(mainFrameFailures - 1) { 20 }
        }
        overlay.show(reason, detail, retryInSeconds)
    }

    private fun hideOffline() {
        offlineOverlay?.let { root.removeView(it) }
        offlineOverlay = null
    }

    /**
     * The system file picker for an `<input type="file" accept="...">`.
     * WebView's own intent keeps only the first accepted type, so a picker
     * that accepts images and text files opened showing PNGs alone; this one
     * passes every type, and a list with an extension Android doesn't know
     * (like .env) opens the picker on all files (the page checks the files).
     */
    private fun filePickerIntent(acceptTypes: Array<String>?): Intent {
        val accepted = (acceptTypes ?: emptyArray())
            .flatMap { it.split(',') }
            .map { it.trim().lowercase() }
            .filter { it.isNotEmpty() }
        val resolved = accepted.map { type ->
            when {
                type.contains('/') -> type
                type.startsWith('.') -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(type.drop(1))
                else -> null
            }
        }
        val mimeTypes = resolved.filterNotNull().distinct()
        val intent = Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE)
        // Two spellings of one type (".jpg,.jpeg", ".zip,application/zip") are
        // still all known; only a type with no MIME match opens every file.
        val allKnown = accepted.isNotEmpty() && resolved.none { it == null }
        when {
            !allKnown || mimeTypes.isEmpty() -> intent.setType("*/*")
            mimeTypes.size == 1 -> intent.setType(mimeTypes.first())
            else -> intent.setType("*/*").putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes.toTypedArray())
        }
        return intent
    }

    private fun openPath(path: String) {
        val safePath = if (isBoardPath(path)) path else "/"
        val server = config.serverUrl
        if (server == null || googleSignIn.needsSignIn) {
            // Kept until the board opens: signing in first must not lose where
            // the notification or shortcut was taking the person.
            pendingPath = safePath
            return showConnect(null)
        }
        if (keyAwaitsProof(server)) {
            // Opened once the server has proved it holds the key.
            pendingPath = safePath
            return proveThenLoad(server)
        }
        pendingPath = null
        installPageKey()
        applyServerCookie()
        webView.loadUrl(server + safePath)
    }

    /**
     * The connect screen. With [wait], it waits for this phone's own Automa
     * (Termux still starting, or stopped) with a visible countdown and opens
     * the board by itself when it answers.
     */
    fun showConnect(error: String?, wait: Boolean = false) {
        keyRecoveryAttempts = 0
        healthFailures = 0
        proofFailures = 0
        reloadWhenServerAnswers = false
        cancelScheduledChecks()
        waitingForServer = wait && config.serverUrl?.let(ServerConfig::isLoopback) == true
        hideOffline()
        val query = listOfNotNull(error?.let { "error=" + Uri.encode(it) }, if (waitingForServer) "wait=1" else null)
        val suffix = if (query.isEmpty()) "" else "?" + query.joinToString("&")
        installPageKey()
        clearHistoryOnServerPage = true
        webView.loadUrl(CONNECT_URL + suffix)
    }

    /** Sends a locked server its app key on every request, as a cookie only this app holds. */
    private fun applyServerCookie() {
        val origin = config.serverOrigin() ?: return
        val secret = config.secretFor(origin)
        // Only to a server that proved it holds the key (loadServer asks first).
        if (secret == null || !ServerConfig.isKeyCleared(origin, secret)) return clearServerCookie(origin)
        val secure = if (origin.startsWith("https://")) "; Secure" else ""
        CookieManager.getInstance().apply {
            // Lax, not Strict: a connector's sign-in comes back to the server as a
            // redirect from the provider's site, and a Strict cookie is left off that
            // request, so the callback refused the person. Lax still keeps it off
            // other sites' forms and fetches; only this app's WebView holds it at all.
            setCookie(origin, "$SECRET_COOKIE=${Uri.encode(secret)}; Path=/; HttpOnly; SameSite=Lax$secure")
            flush()
        }
    }

    private fun clearServerCookie(origin: String) {
        CookieManager.getInstance().apply {
            setCookie(origin, "$SECRET_COOKIE=; Path=/; Max-Age=0")
            flush()
        }
    }

    /**
     * Hands `window.__automaKey` to the app's own pages (the connect screen and
     * the configured server) before any of their scripts run. The bridge
     * refuses calls without it, which is what keeps every other frame in the
     * WebView, sandboxed Studio previews above all, away from the phone. HTML
     * the app serves itself carries the key inline as well, for WebViews
     * without document-start scripts.
     */
    private fun installPageKey() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
        val origins = setOfNotNull(ASSETS_ORIGIN, config.serverOrigin())
        if (origins == pageKeyOrigins && pageKeyHandler != null) return
        pageKeyHandler?.remove()
        pageKeyHandler = null
        runCatching {
            pageKeyHandler = WebViewCompat.addDocumentStartJavaScript(webView, "window.__automaKey=${JSONObject.quote(bridge.pageKey)};", origins)
            pageKeyOrigins = origins
        }
    }

    fun evaluate(script: String) {
        webView.evaluateJavascript(script, null)
    }

    fun pickFolder(callId: String, companyId: String?) {
        pendingFolderCall?.let { bridge.resolve(it, JSONObject().put("ok", false).put("error", "Replaced by a newer request").toString()) }
        pendingFolderCall = callId
        pendingFolderCompany = companyId
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

    /**
     * Automa 1.0 used a different application id, so it stayed on the phone as
     * a second app. Offer once to open its App info page, where Uninstall is.
     */
    private fun offerOldAppRemoval() {
        val prefs = getSharedPreferences("automa", MODE_PRIVATE)
        if (prefs.getBoolean(PREF_OLD_APP_OFFERED, false)) return
        val installed = runCatching { packageManager.getPackageInfo(OLD_APP_PACKAGE, 0); true }.getOrDefault(false)
        if (!installed) return
        prefs.edit().putBoolean(PREF_OLD_APP_OFFERED, true).apply()
        android.app.AlertDialog.Builder(this)
            .setTitle(R.string.old_app_title)
            .setMessage(R.string.old_app_message)
            .setPositiveButton(R.string.old_app_remove) { _, _ ->
                runCatching {
                    startActivity(Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$OLD_APP_PACKAGE")))
                }
            }
            .setNegativeButton(R.string.old_app_keep, null)
            .show()
    }

    /** Developer options, where Wireless debugging (and its pairing code) lives. */
    fun openDeveloperOptions() {
        val intents = listOf(
            Intent(android.provider.Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS),
            Intent(android.provider.Settings.ACTION_DEVICE_INFO_SETTINGS),
        )
        for (candidate in intents) {
            try {
                startActivity(candidate)
                return
            } catch (error: ActivityNotFoundException) {
                continue
            }
        }
    }

    /** The Wireless debugging screen itself (Android 11+), else Developer options. */
    fun openWirelessDebugging() {
        val direct = Intent().setClassName("com.android.settings", "com.android.settings.Settings\$WirelessDebuggingActivity")
        try {
            startActivity(direct)
            return
        } catch (error: Exception) {
            // Not every phone exports it; Developer options is one tap away.
        }
        openDeveloperOptions()
    }

    fun hasTermuxRunPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, TERMUX_RUN_COMMAND_PERMISSION) == android.content.pm.PackageManager.PERMISSION_GRANTED

    /**
     * Starts Automa in Termux in the background (`automa start`) through
     * Termux's RUN_COMMAND, asking Android for that permission the first
     * time. Replies {ok, output} once Termux confirms, {ok, pending} when it
     * has not answered in a while, or {ok:false, reason, error}.
     */
    fun startAutomaInTermux(force: Boolean = false, done: (JSONObject) -> Unit) {
        if (!isTermuxInstalled()) return done(termuxFailure("not_installed", "Install Termux first (from F-Droid), then set up Automa in it."))
        // Termux refused before (allow-external-apps is off). Asking again only
        // makes Termux show its error report; wait for "Try again" instead.
        if (!force && termuxRefusedExternalApps()) {
            return done(termuxNotAllowed().put("skipped", true))
        }
        if (hasTermuxRunPermission()) return launchAutomaInTermux(done)
        // A second request while Android's dialog is up waits for the same answer.
        val earlier = termuxStartAfterPermission
        termuxStartAfterPermission = if (earlier == null) done else { reply -> earlier(reply); done(reply) }
        if (earlier == null) termuxRunPermission.launch(TERMUX_RUN_COMMAND_PERMISSION)
    }

    private fun launchAutomaInTermux(done: (JSONObject) -> Unit) {
        val action = "$packageName.TERMUX_RESULT"
        var finished = false
        lateinit var receiver: BroadcastReceiver
        val finish = { reply: JSONObject ->
            if (!finished) {
                finished = true
                runCatching { unregisterReceiver(receiver) }
                when {
                    reply.optString("reason") == "not_allowed" -> setTermuxRefusedExternalApps(true)
                    reply.optBoolean("ok") && !reply.optBoolean("pending") -> setTermuxRefusedExternalApps(false)
                }
                done(reply)
            }
        }
        val timeout = Runnable { finish(JSONObject().put("ok", true).put("pending", true)) }
        receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                root.removeCallbacks(timeout)
                val result = intent.getBundleExtra(TERMUX_RESULT_BUNDLE)
                val err = result?.getInt("err", TERMUX_ERRNO_SUCCESS) ?: TERMUX_ERRNO_SUCCESS
                val errmsg = result?.getString("errmsg")?.trim().orEmpty()
                val stdout = result?.getString("stdout")?.trim().orEmpty()
                val stderr = result?.getString("stderr")?.trim().orEmpty()
                val exitCode = result?.getInt("exitCode", 0) ?: 0
                finish(
                    when {
                        err != TERMUX_ERRNO_SUCCESS || errmsg.isNotEmpty() -> explainTermuxError(errmsg)
                        exitCode != 0 -> explainTermuxError(stderr.ifEmpty { stdout })
                        else -> JSONObject().put("ok", true).put("output", stdout)
                    },
                )
            }
        }
        ContextCompat.registerReceiver(this, receiver, IntentFilter(action), ContextCompat.RECEIVER_NOT_EXPORTED)
        val flags = PendingIntent.FLAG_ONE_SHOT or
            (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
        val reply = PendingIntent.getBroadcast(this, termuxRequestCode++, Intent(action).setPackage(packageName), flags)
        val run = Intent(TERMUX_RUN_COMMAND_ACTION)
            .setClassName(TERMUX_PACKAGE, TERMUX_RUN_COMMAND_SERVICE)
            .putExtra("com.termux.RUN_COMMAND_PATH", TERMUX_AUTOMA_PATH)
            .putExtra("com.termux.RUN_COMMAND_ARGUMENTS", arrayOf("start"))
            .putExtra("com.termux.RUN_COMMAND_WORKDIR", TERMUX_HOME)
            .putExtra("com.termux.RUN_COMMAND_BACKGROUND", true)
            .putExtra("com.termux.RUN_COMMAND_PENDING_INTENT", reply)
        try {
            startForegroundService(run)
            root.postDelayed(timeout, TERMUX_REPLY_TIMEOUT_MS)
        } catch (error: Exception) {
            finish(termuxFailure("blocked", "Android did not let Automa reach Termux. Open Termux and run: automa run"))
        }
    }

    /** What Termux's refusal means, and what fixes it, in one sentence. */
    private fun explainTermuxError(message: String): JSONObject = when {
        message.contains("allow-external-apps", ignoreCase = true) -> termuxNotAllowed()
        Regex("no such file|not found|does not exist|not exist", RegexOption.IGNORE_CASE).containsMatchIn(message) -> termuxFailure(
            "not_set_up",
            "Automa isn't set up in Termux yet. Follow \"Run Automa on this phone\" below.",
        )
        else -> termuxFailure("failed", "Termux couldn't start Automa" + (if (message.isNotEmpty()) ": ${message.take(300)}" else "."))
    }

    private fun termuxFailure(reason: String, message: String): JSONObject =
        JSONObject().put("ok", false).put("reason", reason).put("error", message)

    private fun termuxNotAllowed(): JSONObject = termuxFailure(
        "not_allowed",
        "Termux needs one setting before Automa can start it: allow-external-apps.",
    ).put("fix", TERMUX_ALLOW_EXTERNAL_APPS_FIX)

    private val termuxPrefs get() = getSharedPreferences("termux", MODE_PRIVATE)

    private fun termuxRefusedExternalApps(): Boolean = termuxPrefs.getBoolean(PREF_TERMUX_REFUSED, false)

    private fun setTermuxRefusedExternalApps(refused: Boolean) {
        termuxPrefs.edit().putBoolean(PREF_TERMUX_REFUSED, refused).apply()
    }

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

    /** A connector's sign-in is running in the app, within its time (see [SignInLinks.WINDOW_MS]). */
    private fun signingIn(): Boolean {
        if (signInStartedAt == 0L) return false
        if (SystemClock.elapsedRealtime() - signInStartedAt < SignInLinks.WINDOW_MS) return true
        endSignIn()
        return false
    }

    private fun beginSignIn(host: String?) {
        signInStartedAt = SystemClock.elapsedRealtime()
        showSignInHost(host)
    }

    /** Names the site on screen above the page, and keeps the page clear of the strip. */
    private fun showSignInHost(host: String?) {
        val bar = signInBar ?: SignInBar(this, onCancel = { cancelSignIn() }).also { created ->
            signInBar = created
            root.addView(created, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP))
            created.addOnLayoutChangeListener { strip, _, top, _, bottom, _, oldTop, _, oldBottom ->
                if (bottom - top != oldBottom - oldTop && signInBar === strip) setWebViewTopMargin(bottom - top)
            }
        }
        bar.show(host.orEmpty())
    }

    private fun endSignIn() {
        signInStartedAt = 0L
        val bar = signInBar ?: return
        signInBar = null
        root.removeView(bar)
        setWebViewTopMargin(0)
    }

    /** Cancel on the strip: back to the board page the sign-in left. */
    private fun cancelSignIn() {
        endSignIn()
        loadServer()
    }

    private fun setWebViewTopMargin(margin: Int) {
        val params = webView.layoutParams as? FrameLayout.LayoutParams ?: return
        if (params.topMargin == margin) return
        params.topMargin = margin
        webView.layoutParams = params
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
        pageKeyHandler = null
        pageKeyOrigins = emptySet()
        installPageKey()
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
            textZoom = textZoomFor(resources.configuration)
            userAgentString = "$userAgentString AutomaAndroid/${BuildConfig.VERSION_NAME}"
            // Rasterize tiles just outside the screen while the view is attached:
            // a fast flick lands on painted content instead of a blank strip.
            offscreenPreRaster = true
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
                if (url.host == ASSETS_HOST) {
                    // The connect screen carries the page key inline (see installPageKey).
                    if (url.path == CONNECT_PATH) bundledUi.serveConnectPage()?.let { return it }
                    return assetLoader.shouldInterceptRequest(url)
                }
                if (config.isOtherServiceOnServerHost(url)) return refusedRequest()
                return bridge.intercept(url) ?: bundledUi.intercept(request, config.serverOrigin())
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (url.scheme == "https" && url.host == ASSETS_HOST) return false
                if (config.isServerUrl(url)) return false
                // A connector's sign-in returns to the server, which knows the person only
                // by this app's cookie: it runs here, and the provider's pages stay here
                // until it is back (the phone's browser arrived signed out).
                if (url.scheme == "https") {
                    if (request.isForMainFrame && SignInLinks.returnsTo(url.toString(), config.serverOrigin())) {
                        beginSignIn(url.host)
                        return false
                    }
                    if (signingIn()) {
                        if (request.isForMainFrame) showSignInHost(url.host)
                        return false
                    }
                }
                openExternal(url)
                return true
            }

            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                val uri = Uri.parse(url)
                bridge.pageOrigin = ServerConfig.originOf(uri)
                reloadWhenServerAnswers = false
                if (config.isServerUrl(uri)) endSignIn()
                if (!downloadHookInstalled) config.serverOrigin()?.let { installDownloadHook(view, it) }
            }

            override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
                val uri = Uri.parse(url)
                bridge.pageOrigin = ServerConfig.originOf(uri)
                if (config.isServerUrl(uri)) {
                    endSignIn()
                    config.lastPath = rememberablePath(uri)
                }
            }

            override fun onPageFinished(view: WebView, url: String) {
                val origin = ServerConfig.originOf(Uri.parse(url))
                if (origin != null && origin == config.serverOrigin()) {
                    // Idempotent (guarded by a window flag); covers the first page after connecting.
                    view.evaluateJavascript(DOWNLOAD_HOOK, null)
                    if (!incoming.isEmpty()) view.evaluateJavascript(SHARE_EVENT, null)
                    if (clearHistoryOnServerPage) {
                        clearHistoryOnServerPage = false
                        view.clearHistory()
                    }
                    confirmServerAnswers()
                }
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (!request.isForMainFrame || !config.isServerUrl(request.url)) return
                val server = config.serverUrl ?: return
                mainFrameFailures += 1
                when {
                    // Automa on this phone stopped (Termux closed) or is still starting:
                    // checked first (a request can fail while it restarts); if it
                    // really is away, the connect screen waits for it and opens the
                    // board by itself.
                    ServerConfig.isLoopback(server) && mainFrameFailures <= 3 -> confirmServerAnswers(reloadWhenAnswering = true)
                    ServerConfig.isLoopback(server) -> {
                        serverWentAway()
                        showConnect(null, wait = true)
                    }
                    mainFrameFailures > 3 -> showConnect("Could not reach ${request.url.host}. ${error.description}")
                    connectivity?.activeNetwork == null -> showOffline(ConnectionOverlay.Reason.OFFLINE, null)
                    else -> showOffline(ConnectionOverlay.Reason.UNREACHABLE, "${request.url.host}: ${error.description}")
                }
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                // The renderer crashed or was reclaimed: rebuild instead of taking the app down.
                endSignIn()
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
                val pick = filePickerIntent(fileChooserParams.acceptTypes)
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
                if (config.isOtherServiceOnServerHost(request.url)) refusedRequest()
                else bridge.intercept(request.url) ?: bundledUi.intercept(request, config.serverOrigin())
        })
    }

    /**
     * The answer for a request the app won't send: the server's app key rides
     * in a cookie, and cookies go to every port of a host, so a request from
     * the board to another program on the server's machine would hand that
     * program the key. Answered here, it never leaves the app.
     */
    private fun refusedRequest(): WebResourceResponse =
        WebResourceResponse(
            "text/plain",
            "utf-8",
            403,
            "Forbidden",
            mapOf("Cache-Control" to "no-store"),
            ByteArrayInputStream(ByteArray(0)),
        )
}
