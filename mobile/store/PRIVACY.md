<!-- Same text as website/PRIVACY.md (the public copy) and the in-app page mobile/android/app/src/main/assets/connect/legal/privacy.html; website/PRIVACY.md is the one to edit, then run the converter noted in mobile/store/listing.md. -->
# Automa Privacy Policy

_Last updated: November 8, 2026_

This policy explains what Automa does with your data. Automa is the Automa app
for Android and the Automa board it opens (including Chats, App Studio,
Terminals and App Inspector). Automa is made and published by Corx Labs, a
Jamaican business ("we", "us").

The short version: Automa has no cloud account, no ads, no analytics and no
tracking. Your organizations, tasks, chats, agents and files live on an Automa
server you control, usually the phone itself. The only data that leaves that
server is what an AI model needs to answer you, and what an agent's tools fetch
from the web when you use them.

## Your Automa server

The app connects to an Automa server that you operate or were given access to:
your phone (inside the free Termux app), your computer, or a server you rent.
Everything you see and create in the app (organizations, tasks, comments,
approvals, chats, agent activity, generated images and documents, App Studio
projects, and files) is stored on that server. We do not operate your server and
we do not receive that data.

When the server runs on your phone, it keeps its database, hourly backups and
the backups made by `automa backup` in Termux's private storage. Nothing is
uploaded anywhere by the backup feature.

The server's own usage reporting (Paperclip telemetry) is turned off by the
installer on the phone. It can be turned on by setting
`PAPERCLIP_TELEMETRY_DISABLED=0` in Termux; leave it as installed and nothing is
reported.

## Your account and sign-in

When Automa runs on your phone there is no account. The installer makes a key
that only the Automa app knows, the app proves the server holds that key before
it sends it, and the server answers only the Automa app. Signing out and in
again never leaves the phone.

When you connect to an Automa server on a computer, you sign in to that server
with the name and password its owner set up, or with an invite link. That
server, not us, holds your account.

**Google sign-in and push notifications** exist only in builds set up with
Google Firebase. The builds published on APKPure (1.9.7 and newer) are not:
they show no "Continue with Google" button, have no push service, and send
nothing to Google. If a future build adds them, this applies: your Google name, email
address, profile photo link and a user ID would be stored in our Firebase
Authentication project (run by Google for us) so you can sign in, the app would
pass your Automa server a short-lived sign-in token, and Firebase Cloud
Messaging would give the phone a push token that the app registers with your
server. We would use these only to sign you in and to notify you.

## Notifications

If you allow notifications, the app shows one when an AI reply or a team job
finishes while the app is out of sight, and when an agent needs a file or an
approval is waiting. The board page asks the app to show it over its own
connection to your server. No notification service outside the phone is
involved.

## AI models

Automa's agents answer with AI models. What goes to a model is exactly what the
agent needs to reply: the messages of that chat (the newest 40 since the last
`/new`), the agent's instructions and role, the names of attached files, images
when the model can see them, the text of documents the agent reads with its
tools, and the result of every tool it uses. Every tool step is shown in the
chat as it happens.

- **Free models.** When an agent, Moan or App Studio uses Automa's free models
  (the default, with no key), your server sends that data to the free AI service
  Automa uses, which passes it to the company that runs the model you picked
  (for example OpenAI, Google, DeepSeek, xAI or NVIDIA). The free models are
  shared by everyone using Automa and are run by those companies under their own
  terms, so do not send them anything you would not give a third-party AI
  service. To show your remaining free usage on the Costs page, your server asks
  the free AI service how much has been used.
- **Your own keys.** When you add an API key or sign in to a provider (Claude,
  Codex, Gemini, Cursor and others), your server sends the same data straight to
  that provider, with your key, under that provider's privacy policy. Keys are
  stored on your server, encrypted; agents and terminals never see them.
- **Images.** Pictures an agent draws or edits are made by the image model of
  the free AI service (or the provider you chose) and stored on your server.
  Pictures you attach are sent to the model only when the model can see images.
- **Moan.** Moan answers from a Jamaica knowledge index that your server builds
  by fetching public pages from Jamaican news, government, law and reference
  websites on a schedule. Those sites see a normal web request from your
  server's connection and nothing about you. The index holds only those public
  pages, never your data.

## Agents' web tools

When an agent's web tools are on, its searches go to DuckDuckGo, or to Bing
when DuckDuckGo refuses to answer, and the pages it reads are downloaded by your
server from their own sites, which see your server's connection. Links in chats show each site's icon, loaded from that
site. Web tools never reach private or local addresses.

## Connected apps

If you connect an app (Gmail, GitHub, Notion, Slack and others) for your agents,
the sign-in tokens for it are stored on your server, encrypted, and used only by
the agents you allowed. What an agent reads from a connected app becomes part of
the conversation and can be sent to the AI model, as described above.

## App Studio

- Studio projects (your files, console output and collaboration chat) are stored
  on the Automa server that hosts them. We do not receive them.
- When you ask the Studio assistant or a team of models for help, the files and
  console output they read are sent to the AI model as described under
  "AI models".
- When you turn on a public link, your app (not the rest of Automa) is reachable
  through Cloudflare by anyone with the link until you turn it off.
- People you invite with a share code see that workspace's files and chat, and
  the name they choose when they join is shown to you.
- Cloning from GitHub downloads the repository you enter directly from GitHub to
  your server.
- Previews run sandboxed: a preview cannot act as you or reach the rest of
  Automa.

## Agents on your phone

When Automa runs on your phone, its agents and Terminals run commands in Termux
on that phone, in Automa's own folder. If you link **Wireless debugging** with
`automa adb link`, agents you ask can also act on the phone through the Android
shell: open apps, tap and type, read settings and take screenshots. A screenshot
an agent takes is sent to the AI model like any other image. Turn Wireless
debugging off in Developer options to take that away again. App Inspector opens
an APK you pick on the phone; the file never leaves your server.

## On your phone

The app itself keeps:

- your server address and recent addresses, and a random installation ID sent
  to your server to recognize this phone;
- sign-in cookies from your server, kept by Android's WebView;
- files you pick, share to the app or place in the one folder you share. They
  are read only when you (or auto-send, if you turned it on) send them to your
  server. Shared files wait in the app's private storage until you send or
  discard them;
- downloads, saved to Downloads/Automa.

The app asks for internet access, the notification permission, and the Termux
permission that lets it start Automa on the phone. It does not ask for
location, contacts, camera, microphone or broad storage access. You can revoke
folder access in the app (Stop sharing) or in Android settings.

## Sharing and selling

Data goes to the Automa server you choose and from there to the AI providers,
websites and connected apps described above, only when you or your agents use
them. The app contains no advertising or analytics SDKs. We do not sell data and
we do not receive your data at all.

## Security

Use an HTTPS address for a server on the internet. On a plain HTTP address on a
private network (home Wi-Fi, or a VPN such as Tailscale) traffic on that network
is not encrypted by the app. On the phone, Automa listens on the phone only and
answers only the Automa app. Keys saved for AI providers and connected apps are
encrypted on your server, and agents never see the server's database password or
sign-in secret. The full threat model is published with Automa's source as
`doc/AUTOMA-SECURITY.md`.

## Keeping and deleting data

Server data is kept and deleted by your server's settings. You can delete chats,
tasks, files, agents and whole organizations in the app, and remove devices on
the Files page. Uninstalling the app removes everything it stored on the phone;
uninstalling Termux removes the server and its
data from the phone. If a future build includes Google sign-in, contact us to
delete that account.

## Children

The app is not directed to children under 13.

## Changes and contact

We will post changes here and update the date above. Questions or deletion
requests: ask on our [Discord support server](https://discord.gg/NfnSrFK7YM) or
use the support email on Automa's APKPure page.

© 2026 Corx Labs · Made in Jamaica 🇯🇲
