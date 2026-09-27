# Automa for Android

The Automa Android app is a native companion for an Automa server. Your
agents keep running where they run today (your computer, a cloud VM, or a
container); the phone becomes the place you check on them, answer what needs
you, start tasks, and move files between your phone and your agents.

```
Phone (Automa app) ──HTTPS/HTTP on your network──▶ Automa server ──▶ agents
   │  Files page, share sheet, shared folder            │
   └──────────── agents ask the phone for files ◀───────┘
```

## What the app does

- **Every board feature, with the UI inside the APK**: the board UI ships in
  the app itself, so the phone layout (create buttons in the thumb zone, the
  mascot, Undo, haptics) is the same whatever server version you connect to.
  Your server supplies the data: tasks, approvals, agents, routines,
  connectors, costs, and settings all work.
- **Device Files** (new): connect the phone, share one folder, and agents can
  pull the files they need from it. With auto-send on, a requested file in
  that folder is sent without asking; otherwise the request waits on the
  Files page for you to pick a file or decline. Agents can also send files
  back to the phone.
- **Share to Automa**: share any file from another app; it waits on the Files
  page until you confirm sending it to your agents.
- **Downloads**: attachments and exports save to `Downloads/Automa`.
- **Screens**: edge-to-edge on Android 15/16, safe around camera cutouts and
  the gesture bar, keyboard-aware, portrait and landscape, phones, tablets,
  foldables, and Chromebooks (`resizeableActivity`, no orientation lock).
- **Launcher shortcuts**: Files, New task, Change server.
- **Feel**: primary actions sit in the thumb zone, destructive actions have
  Undo, and taps, sends, limits, and successes use Android's own haptics
  (they follow the phone's touch-feedback setting; no vibrate permission).

## Requirements

- An Automa server the phone can reach. Start it with network access:
  `npx paperclipai onboard --bind lan` (same Wi-Fi) or `--bind tailnet`
  (Tailscale), then connect the app to the address it prints. If the server
  rejects the phone's address, allow it with
  `npx paperclipai allowed-hostname <address>`. For access from anywhere, put
  the server behind HTTPS.
- Android 8.0 (API 26) or newer.

### Running the server on the phone itself (advanced, untested)

The server is a Node.js 24 app with Postgres, so it can run inside Termux on
the same phone and the app can connect to `127.0.0.1:3100`. This path is not
covered by our tests: install Node.js and PostgreSQL from Termux, set
`DATABASE_URL` to the Termux Postgres, and start Automa. Local CLI agents
(Claude Code, Codex, …) must also be installable in Termux.

## Build

Requirements: JDK 17+ and the Android SDK (platform 36, build-tools 36).

```sh
pnpm install
pnpm mobile:bundle-ui        # builds the board UI and copies it into the app (assets/ui)
cd mobile/android
echo "sdk.dir=$ANDROID_HOME" > local.properties
./gradlew assembleDebug      # app/build/outputs/apk/debug/app-debug.apk (id: app.automa.android.debug)
./gradlew lintDebug          # Android Lint (0 errors expected)
```

Run `pnpm mobile:bundle-ui` again whenever the UI changes. Release builds
refuse to build without the bundled UI; a debug build without it shows the
server's own UI instead.

Install on a phone with USB debugging: `adb install -r app/build/outputs/apk/debug/app-debug.apk`,
or copy the APK to the phone and open it (allow "install unknown apps").

### Release build (Play Store)

1. Create an upload key once and keep it safe (losing it means asking Google
   to reset your upload key):
   ```sh
   keytool -genkeypair -v -keystore automa-upload.jks -alias automa-upload \
     -keyalg RSA -keysize 4096 -validity 10000
   ```
2. Create `mobile/android/keystore.properties` (git-ignored):
   ```properties
   storeFile=/absolute/path/to/automa-upload.jks
   storePassword=...
   keyAlias=automa-upload
   keyPassword=...
   ```
3. Set your own `automa.applicationId` in `gradle.properties` (for example
   `com.yourcompany.automa`). It must be unique on Google Play and can never
   change after the first upload. Bump `automa.versionCode` for every upload.
4. Build:
   ```sh
   ./gradlew bundleRelease     # app/build/outputs/bundle/release/app-release.aab  → upload to Play Console
   ./gradlew assembleRelease   # app/build/outputs/apk/release/app-release.apk     → direct install / testing
   ```

Release builds are shrunk with R8; `proguard-rules.pro` keeps the
JavaScript bridge methods.

## Play Store checklist

| Requirement | Status |
|---|---|
| Target API level | `targetSdk 36` (Android 16) |
| App Bundle | `bundleRelease` produces the AAB |
| 64-bit / 16 KB pages | No native code, so both are satisfied |
| Edge-to-edge (required for API 35+) | Insets applied in `MainActivity` |
| Large screens / foldables | Resizable, no orientation lock, config changes handled |
| Permissions | `INTERNET`, `ACCESS_NETWORK_STATE` only; files use the system pickers (no storage permission) |
| Store icon 512×512 | `store/app-icon-512.png` |
| Feature graphic 1024×500 | `store/feature-graphic-1024x500.png` |
| Phone screenshots (1080×1920) | `store/screenshots/phone/` |
| Tablet screenshots | `store/screenshots/tablet/` |
| Listing text | `store/listing.md` |
| Privacy policy | Draft in `store/PRIVACY.md`; host it at a public URL |
| Data safety form | Answers in `store/listing.md` |

Before you submit:

- **Name check**: "Automa" is used by other software products (for example a
  browser-automation extension). Search Google Play and trademark databases,
  and pick a distinct listing name if needed.
- **Open-source notice**: Automa is built on Paperclip (MIT). Keep the
  repository `LICENSE` and credit Paperclip in your listing or an in-app
  "About" page.
- **New developer accounts**: Google requires personal developer accounts to
  run a closed test (currently at least 12 testers for 14 days) before the
  first production release.
- **Reviewer access**: Play reviewers need a reachable demo server and
  credentials; enter them under App content → App access.

## How the app is built

`mobile/android` is a small Kotlin app (no cross-platform framework):

| File | Role |
|---|---|
| `MainActivity.kt` | WebView host: insets, navigation, file chooser, downloads, share intents, back, renderer-crash recovery |
| `AutomaBridge.kt` | `window.AutomaNative` for the page (contract: `ui/src/lib/automa-native.ts`); origin-checked |
| `SharedFolder.kt` | Storage Access Framework access to the one folder you share |
| `IncomingShares.kt` | Share-sheet inbox (copied to private cache until you confirm) |
| `Downloads.kt` | Saves downloads to `Downloads/Automa` with the session cookie |
| `ServerConfig.kt` | Server address, recent servers, install identity, health check |
| `BundledUi.kt` | Serves the bundled board UI (`assets/ui`) on the server's origin; `/api` still goes to the server |
| `assets/connect/` | The bundled first-run connect screen |

How the bundled UI loads: pages keep your server's address, so sign-in
cookies, the API, live updates, and plugin UIs behave exactly as in a
browser. The app answers only the UI's own files (the page shell and
`/assets/…`) from the APK; every `/api/…`, `/_plugins/…`, and `/mcp/…`
request goes to the server. Newer app versions can therefore need a
server that has the matching API (for example, Files needs the Device Files
API from this release).

Security notes: only the configured server origin (and the bundled connect
screen) loads inside the app; every other link opens in the browser. Bridge
methods check the calling page's origin. File bytes never cross the bridge as
strings; the page fetches them from same-origin URLs the app serves locally
with a per-process token. Cleartext HTTP is allowed because self-hosted
servers are often plain HTTP on a LAN or tailnet; the connect screen suggests
HTTPS outside private networks.
