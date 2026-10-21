# Automa security: threat model, what-ifs, and the controls

Automa is Paperclip with an Android app, App Studio (a coding workspace with
collaborators), Device Files, and "Run Automa on this phone" (the server in
Termux). This page is the white-box review of those additions: who could
attack what, the "what if" for each, and what the code does about it. It is
written to be re-read whenever one of these surfaces changes.

The one rule behind everything below: **the client is never trusted**. A
modified board UI, a userscript that re-enables a disabled button, a replayed
request from a terminal, a frame inside the app's WebView — all of them reach
the same server routes, and only what the server allows happens. Buttons are
hints; routes are the law.

## 1. Who is where

| Principal | Where it runs | Trust |
|---|---|---|
| The operator | The Automa app, or a browser on a server they own | Full (the board) |
| Another app on the phone | Same device, same loopback | None |
| A Studio collaborator | Their own browser, through the gateway or a tunnel | Guest: read, type, chat, propose |
| An app built in Studio | A sandboxed preview frame, and a process on a port | None |
| An agent | A process with an agent API key | Agent: its company only |
| A server the operator connects to | Anywhere | Trusted with what the app sends it |
| The network between app and server | Wi-Fi, the internet | Hostile unless HTTPS or local |

## 2. The phone's shared loopback

**What if another app on the phone talks to Automa on `127.0.0.1:3100`?**
Paperclip's `local_trusted` mode treats every request as the operator. On a
laptop loopback is private; on Android every installed app can open it. So
Automa in Termux is *locked*: the installer makes an app key
(`~/.automa/app-secret`), the launcher exports it as
`PAPERCLIP_LOCAL_TRUSTED_SECRET`, and only a request carrying it (the app's
`paperclip_local_secret` cookie, or the secret as a bearer for the CLI) is the
board. Everything else on the phone is anonymous: public routes and agent keys
still work, the board does not (`server/src/middleware/local-trusted-secret.ts`,
`doc/DEPLOYMENT-MODES.md`). The live-events and Studio sockets apply the same
rule.

**What if another app talks to the database on `127.0.0.1:5432`?** The
database asks for a password even from loopback (`initdb --auth=scram-sha-256`,
password in `~/.automa/db-password`, readable by Termux alone). A database made
by an older installer gets the password and the `pg_hba.conf` change on the
next install. Postgres' data directory lives in Termux's private storage,
which Android keeps from other apps.

**What if an app sends Automa an intent saying "connect to
`http://127.0.0.1:4444`" and runs a fake server there, to collect the
sign-in?** A connect intent counts only for a loopback address, and a new
address or key is never applied by itself: it waits on the connect screen with
"Termux asked to connect to …", and takes effect after a tap on Connect. An
address and key the app already has pass silently (that is the launcher
restarting). A new key for the loopback server the app is already using is
applied only after the app has checked it against that server (the server
must list its organizations with it); a key the server rejects waits on the
connect screen like a new address would. A page that finds its key missing
asks the app for it once and waits a few seconds before showing guidance. The same screen shows where you are connecting, the server's
version, and whether it is locked.

**What if an app sends Automa a path to open, or a file to share?** A path
only navigates inside the configured server (it must start with `/`, never
`//`). A shared file waits on the Files page until the person confirms it.

## 3. The WebView

**What if an app built in Studio, shown in its preview frame, calls
`window.AutomaNative`?** Android injects a JavaScript interface into every
frame of a WebView, including sandboxed ones. Every bridge method therefore
takes a page key that the app hands only to its own pages (a document-start
script scoped to the connect and server origins, and inline in the HTML the
app serves). A sandboxed preview has an opaque origin and never gets the key;
a call without it does nothing. Previews are also served with
`Content-Security-Policy: sandbox` (no `allow-same-origin`), so their requests
are cross-site: the app key cookie is `SameSite=Strict` and is not sent, and
a mutation with `Origin: null` is refused.

**What if the server you connected to is malicious?** It gets what the page
can ask the bridge for: the device name and install id, a Google sign-in token
when it says it runs in authenticated mode, the push token, files you share.
That is the trust you give any server you choose. Two limits hold anyway: the
Google sign-in token is handed over only to an `https://` server or one on a
private network (never plain HTTP across the internet), and the success screen
warns when a public address is plain HTTP. Downloads a page saves go through a
sanitized filename into `Downloads/Automa`.

**What if a page tries to leave the server's origin?** Only the configured
server origin and the bundled connect screen load inside the app; every other
link opens in the system browser. No file access, no content providers, no
mixed content, no pop-ups, camera and microphone denied, geolocation denied.

**What if someone copies the app's preference file?** The app key is sealed
with an AES-GCM key in the Android Keystore (`SecretStore.kt`); the stored
value is useless without this device's hardware key. Backups are off.

## 4. App Studio

**What if a collaborator calls an owner route?** Owner routes need the board
(`assertBoard`); guests hold a separate token checked by `guestByToken`.
Through the gateway only `/studio-guest/…`, `/api/studio-guest/…`, previews,
static assets and the mascot pass; the gateway drops cookies and
authorization headers and marks requests with `x-studio-gateway`, which the
main app refuses outside those paths and the owner socket refuses outright.

**What if a collaborator writes a file?** They cannot: live typing is relayed
to screens, never saved. A change is a proposal; the owner sees a red/green
diff and accepts, edits or denies, and the "before" text is computed on the
server, not sent by the guest. Paths are normalized and resolved inside the
project; symlinks out are refused.

**What if a collaborator joins as "Owner", or as someone already in the
project?** Refused with "That name is already taken in this project":
reserved names (`Owner`, `Automa`, `System`, …), the owner's name and active
collaborators' names are compared after trimming, collapsing spaces, lower-
casing and removing invisible characters.

**What if someone guesses share codes?** Codes are eight characters from a
32-letter alphabet (about 10¹² combinations), can carry an expiry, can be
revoked, and wrong codes are limited: ten per client and forty overall per ten
minutes, then `429` with `Retry-After`. Through a tunnel every request looks
local, so the client key is the tunnel's `cf-connecting-ip`.

**What if a browser on another site opens the owner's live socket?** The
socket compares the `Origin` with the host it reached; another site, or a
sandboxed frame (`null`), is refused. Non-browser clients send no `Origin`.

**What if a browser on another site posts to a `local_trusted` instance?**
A board mutation that carries an `Origin` must come from the instance's own
pages (same host, or `PAPERCLIP_PUBLIC_URL`). Requests without an `Origin`
(the CLI) are unchanged.

**What if the cloned repository is hostile?** Clones are shallow, over
https only (no `ssh`, `file`, `ext::`), with prompts disabled and a five-minute
limit; no hooks run on clone. What the project then does when *you* run it is
your decision: the runner is yours, on your device.

**What if the cloudflared download is tampered with?** It comes from
GitHub over HTTPS and is kept only if it is an ELF binary of plausible size;
a redirect to an error page is thrown away. Tunnels point at the app's port or
the gateway, never at Automa itself.

**What if a collaborator reads the owner's AI keys?** Keys are stored
encrypted (`localEncryptedProvider`), listed only as "set / last 4", and used
server-side; no guest route returns them. The one place a key comes back out
is the board's own API keys page (Settings → API keys → Copy key): board only,
never a viewer, only a key the caller may use (their own, or a shared one),
and every copy is an audit entry (`ai_connection.credential_revealed`). The
board already controls every agent that runs with the key, so showing it
again to the board adds no reach; the log makes it visible.

**What if Studio uses a key it was not given?** Studio's assistant takes the
key saved in Studio for that provider; without one it falls back to the
organization's key for the same provider from the API keys page, selected
with the same ownership rules as an agent run (the caller's default, else a
key the caller may use). It never reads another member's personal key.

## 5. Accounts and data

- Sign-in with Google is a Firebase ID token verified on the server against
  Google's certificates (signature, audience, issuer, expiry); it signs in or
  creates the account for that email, so an email already registered is that
  person's account, never a second one.
- Agent API keys and collaborator tokens are stored as SHA-256 hashes; secrets
  and Studio AI keys are encrypted at rest with the instance master key.
- Push tokens never leave the server: the API only says `pushEnabled`.
- Nothing in this fork sends data anywhere Paperclip did not already.

## 6. What this does not cover

- A rooted phone, or someone with the unlocked phone in hand.
- A server you choose to connect to, beyond the limits in §3.
- Code you run yourself in Studio or Termux: it runs with your permissions.
- The upstream Paperclip code outside the surfaces above; keep the fork
  current with upstream for its fixes.

## 7. Checks that keep this true

- `server/src/__tests__/local-trusted-secret.test.ts`: the secret, cookie and
  bearer forms, `Origin: null`, cross-site mutations, socket origin matching.
- `server/src/__tests__/studio.test.ts`: gateway paths, path traversal and
  symlinks, Git URL rules, child environment without secrets, join limiter,
  claimed names.
- `server/src/__tests__/authz-existence-oracle-guard.test.ts`: missing and
  other-company resources answer the same 404.
- The browser checks in this session's scratchpad: the connect screen with a
  fake bridge (every call carries the page key), and a locked instance end to
  end (anonymous 403, cookie and bearer accepted, sockets, join limit, notice).
