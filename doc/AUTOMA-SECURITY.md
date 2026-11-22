# Automa security: threat model, what-ifs, and the controls

Automa is Paperclip with an Android app, App Studio (a coding workspace with
collaborators), Device Files, "Run Automa on this phone" (the server in
Termux), and the direct Anthropic API engine that lets Claude agents answer
where Claude Code can't run. This page is the white-box review of those additions: who could
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
sanitized filename into `Downloads/Automa`. It can also set the app's language
(`setLanguage`, 1.9.14, server pages only): `AppLanguage.normalize` keeps only
`auto` or one of the 40 codes, so the most it can do is change the language of
the app's own screens. Only the app's own pages read the choice back
(`getLanguage`, for the connect screen).

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
- Sign-in tries are limited per caller (Better Auth: three per ten seconds on
  sign-in, sign-up, password and email change). The caller is `req.ip`, which
  follows the operator's `TRUST_PROXY` policy (no proxy trusted unless named):
  `createBetterAuthHandler` stamps it into `x-paperclip-auth-client-ip` after
  dropping any copy the caller sent, and Better Auth reads only that header.
  A made-up `X-Forwarded-For` neither escapes the limit nor lands every
  header-less caller in one shared bucket, and sessions record the real
  address (1.9.13; before, Better Auth trusted `X-Forwarded-For`).
- The board's page answers with `X-Frame-Options: SAMEORIGIN` and
  `frame-ancestors 'self'`, so another site cannot frame it to steer clicks;
  `/api` answers carry `X-Content-Type-Options: nosniff`; Express is not
  announced (`middleware/security-headers.ts`).
- The free models' built-in token is stored masked (XOR with a random 24-byte
  mask, both halves base64) in `packages/shared/src/puter-ai.ts`, and every
  build checks the board bundle, the phone server bundle and the whole APK for
  it whole, in pieces of ten or more characters of its signature, or
  base64'd (`scripts/check-free-model-token.mjs`), refusing to ship on a hit.
  The server must unmask it to call the service, so someone with the phone
  and time can recover it; the mask stops `strings` and casual copying, not a
  determined reverse engineer. APKs up to 1.9.12 and the repository's history
  hold it readable: only rotating the token removes those. An operator's
  `PUTER_AUTH_TOKEN` replaces it.
- On the phone, `install.sh` sets the database password and the app key to
  0600 on every install and update, also when an older installer left one
  readable. Android gives each app its own user id, so this keeps other apps
  out; the phone's owner can always read their own files.
- Translations of the board (1.9.14): `POST /api/ui-translations` (board
  users) accepts only strings in `UI_STRINGS`, the board's build-time list of
  its own English wording (13,722 entries, `packages/shared/src/ui-strings.generated.ts`);
  any other text, such as names, chat messages or task titles, is refused, so
  nothing a person wrote reaches the free models this way. Accepted strings go
  to the free models in batches of 30, at most 2,000 new strings per person per
  hour; a translation is kept only with the same `{n}` placeholders, no HTML or
  link the English lacks, and at most four times its length
  (`acceptUiTranslation`). They are saved per language in
  `data/ui-translations/<language>.json` in the instance folder and shared by
  everyone on the instance (an `AGENTS.md` exception: they hold no company or
  user data). People's own words on the board (chats, replies, notes, terminals,
  run output) are marked `translate="no"` and never matched. The app's own
  messages the board shows (`NATIVE_ERRORS`) are on that list as templates: an
  address or file name in one is filled in on the device, never sent. The
  connect screen's translations ship inside the app
  (`assets/connect/i18n/<language>.json`) and are neither downloaded nor sent
  anywhere.
- Language preferences (1.9.14): `user_language_preferences` holds a person's
  choice (`auto` or a language) and what Auto found on their device (language,
  locale, country, time zone); instance-wide per person (an `AGENTS.md`
  exception, like the sidebar's company order), read and written only by that
  person through `/api/language-preferences/me` (board users; unknown values and
  extra fields are refused). An agent run is told only the language and country
  of the person it answers.
- The model lists download OpenRouter's public model catalog (`/api/v1/models`,
  no credentials, nothing sent but the request) at most every 12 hours; the
  server already fetched it for free-model price estimates and OpenCode's
  list, which now read the same copy.
- The direct API engine is the one new outbound path. When a Claude agent
  answers through the Anthropic API (on a phone, with that engine chosen, or
  when Claude Code's engine can't start on a local target), the server
  process itself sends the chat history, the agent's instructions and image
  attachments to Anthropic, or to the `ANTHROPIC_BASE_URL` in the agent's
  env, with the agent's key. The agent's setup check lists models with the
  same key. Remote and sandbox targets never switch to it. App Studio's
  assistant already sent prompts to the provider picked in Studio. Apart
  from these, nothing in this fork sends data anywhere Paperclip did not
  already.
- **Which key the direct engine uses**: the `ANTHROPIC_API_KEY` in the
  agent's env, which the API keys page provides. A key the agent's env sets
  to blank stays blank (the server blanks it on purpose for subscription
  sign-ins), so the host's key is never borrowed for those. Only an agent
  whose env doesn't mention the key falls back to the key the server was
  started with, for any company on that server: on a shared server, don't
  start it with one. The request never sends a bearer token from the host
  env, and pasted keys lose invisible characters before they are stored.

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
- `packages/adapters/claude-local/src/server/direct-api.test.ts`: a blank
  key in the agent's env is respected, no host bearer token is sent, usage
  is kept on refusal and stop, and thinking matches the model.
- `server/src/__tests__/better-auth-rate-limit.integration.test.ts`: the
  sign-in limit holds against a made-up `X-Forwarded-For` per guess and behind
  a trusted proxy, and sessions record the real address.
  `server/src/__tests__/security-headers.test.ts`: the board and API headers.
- `scripts/check-free-model-token.test.mjs` and
  `packages/shared/src/puter-ai.test.ts`: the token check finds whole, split,
  base64'd and binary copies and never prints the token; the source holds no
  12-character run of it. `server/src/__tests__/termux-pkg-script.test.ts`:
  both phone secrets are 0600 after an install over a readable one.
- `server/src/__tests__/secret-leak-guards.test.ts`: apps App Studio runs get
  none of the server's secrets, and the built board (`ui/dist`, the app's
  `assets/ui` and `assets/connect`) holds no copy of the free-model token, by
  the release check's own finder, and no key-shaped string. Until 1.9.14's
  check before release it read the token's pieces from a list that masking
  the token removed, so it looked for nothing.
- `server/src/services/terminals/free-complete-script.test.ts`: IMY's
  free-models bridge sends only the user and assistant turns, after its own
  system message, to the exact model asked for. It refuses requests it can't
  read without calling the service. It never prints the token, even when the
  service echoes it in a refusal.
- `imy-engine/tests`: a key typed into `imy init` is stored at mode 0600 and
  never printed. Programs IMY runs get no `IMY_API_KEY`. `imy inject` rejects
  git URLs that could run commands (`ext::`, leading `-`), and `--fresh`
  removes only an earlier clone of the same repository, never another folder
  `--dest` names. Paths stay inside the repository and the virtual file
  system. A project's `.env` file (1.9.15, `tests/test_config.py`) cannot name
  the bridge command, the Python that runs programs, IMY's home or the
  variable the key is read from, and may point `IMY_BASE_URL` only at this
  computer: a downloaded project could otherwise run a command or have the
  person's key sent to another server. A key saved for one provider is not
  sent to another chosen for one run.
- `server/src/services/terminals/status.test.ts` (1.9.15): what the status
  looks for on the host is quoted as one word (IMY's command is a path in the
  home folder), and the installed IMY version is read from a folder name,
  with no program started.
- `server/src/__tests__/assets.test.ts`: photos and logos must really be
  images. `server/src/__tests__/error-handler.test.ts`: oversized bodies and
  bad ids answer 413 and 400, not 500.
- The browser checks in this session's scratchpad: the connect screen with a
  fake bridge (every call carries the page key), and a locked instance end to
  end (anonymous 403, cookie and bearer accepted, sockets, join limit, notice).
