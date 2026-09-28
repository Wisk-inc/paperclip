<!-- The in-app copy lives in mobile/android/app/src/main/assets/connect/legal/; keep both in sync. Host this at a public URL for Google Play. -->
# Privacy Policy
_Last updated: September 28, 2026_

This policy explains what the Automa app for Android, published by Corx Labs, does with your data.

## Your Automa server
The app connects to an Automa server that you operate or were given access to. Everything you see and create in the app (tasks, comments, approvals, agent activity, and files) is stored on that server. We do not operate your server and do not receive that data.

## Your account
When you choose "Continue with Google", your Google name, email address, profile photo link, and a user ID are stored in our Firebase Authentication project (run by Google for us) so you can sign in. The app also gives your Automa server a short-lived sign-in token so it can sign you in with the same account. We use this only to sign you in.

## Notifications
If you allow notifications, Firebase Cloud Messaging gives this phone a push token. The app registers it with your Automa server, which uses it to tell you when an agent needs a file or an approval is waiting. It is not used for advertising.

## On your phone

- Your server address and recent addresses, and a random installation ID sent to your server to recognize this phone.
- Sign-in cookies from your server, kept by Android's WebView.
- Files you pick, share to the app, or place in the one folder you share are read only when you (or auto-send, if you turned it on) send them to your server. Shared files wait in the app's private storage until you send or discard them.
- Downloads are saved to Downloads/Automa.

The app does not ask for location, contacts, camera, microphone, or broad storage access. You can revoke folder access in the app (Stop sharing) or in Android settings.

## Sharing
Data goes to the Automa server you choose and, for sign-in and notifications, to Google Firebase. The app contains no advertising or analytics SDKs, and we do not sell data.

## Security
Firebase traffic is encrypted. Use an HTTPS address for your server; on a plain HTTP address on a private network (home Wi-Fi or a VPN such as Tailscale), traffic on that network is not encrypted by the app.

## Keeping and deleting data
Server data is kept and deleted by your server's settings; you can delete files and remove devices on the Files page. To delete your account, contact us. Uninstalling the app removes everything it stored on the phone.

## Children
The app is not directed to children under 13.

## Changes and contact
We will post changes here and update the date above. Questions or deletion requests: use the support email on Automa's Google Play page.
