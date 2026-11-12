# APKPure listing

Texts and assets for Automa's APKPure page (they fit Google Play's limits too,
so the same listing works there). The policy the listing links to is
`website/PRIVACY.md` (hostable copy: `website/privacy.html`).

## App name (max 30)

Automa: AI company control

## Short description (max 80)

Free AI agents that chat, search, draw, build apps and run tasks on your phone.

## Long description (max 4000)

Automa turns your phone into a company run by AI agents. Hire agents, give them roles, chat with them like teammates, hand them tasks, let them build and run apps, draw pictures, search the web and work with your files. You approve anything that matters.

It runs on free AI models with no key, no account and no card, or on your own API keys and subscriptions (Claude, GPT, Gemini, DeepSeek, Grok and more). The agents work on an Automa server you control: the phone itself (inside the free Termux app), your computer, or a server you rent. There is no Automa cloud account, no ads and no tracking.

FREE AI, NO KEY NEEDED
• Pick from more than 20 free models: DeepSeek V4.1 Flash, Nemotron 3 Ultra, Gemma 4, Qwen 3.8 and others. Switch models mid-chat.
• The Costs page shows your free usage per model, with the limits and when they reset, and what the same work would have cost on paid plans.
• Add your own keys when you want a paid model, and set budgets that stop spending on their own.

CHAT WITH YOUR AGENTS
• Every agent has a role and instructions, and remembers the chat. Type /new to start fresh.
• Agents search the web and read pages, with the sources shown under the answer.
• Agents draw and edit pictures, and make spreadsheets, presentations and documents you can download.
• Attach files and photos; agents can ask your phone for the files they need.
• Moan, the Jamaican assistant, answers in Patois and knows Jamaica's news, law and government from public sources.

RUN THE COMPANY
• Tasks: hand work to an agent, follow it, and approve the result when it comes back for review.
• Inbox: approvals, file requests and questions from agents, all in one place.
• Projects, goals, routines and an org chart that shows who reports to whom.
• Hire agents from a catalog of roles or write your own.
• Connect Gmail, GitHub, Notion, Slack and other apps for your agents, with per-agent access.

APP STUDIO
• Describe an app and a team of AI models plans, writes and runs it, with a live preview on the phone.
• Edit the code yourself, undo any change, share a workspace with a code, or publish a public link.
• Terminals give agents a real shell on the server, and App Inspector opens any APK.

ON THE PHONE, NO COMPUTER NEEDED
• Install the free Termux app, send Automa to it from the connect screen, paste one line, and the server runs on the phone.
• Automa on the phone answers only the Automa app. Backups are one command away.
• Or connect the app to an Automa server on your computer or in the cloud.

PRIVATE BY DESIGN
• Your organizations, tasks, chats, agents and files stay on your server.
• The only data that leaves it is what a model needs to answer you, and what an agent's web tools fetch when you use them.
• The app asks only for internet and notifications. It can read one folder you choose, and you can stop sharing at any time.
• Every tool step an agent takes is shown in the chat as it happens.

Automa needs Android 8.0 or newer, about 100 MB of storage, and internet for the AI features. Running the server on the phone needs the free Termux app (from F-Droid). Free models are shared by everyone using Automa and come with usage limits; your own keys have none.

Made in Jamaica by Corx Labs.

## Category

Business (alternative: Productivity)

## Tags / keywords

AI agents, free AI, chat, task management, approvals, app builder, automation, file sharing, Jamaica

## Contact

Support: https://discord.gg/NfnSrFK7YM
Privacy policy URL: the public URL of `website/PRIVACY.md` (or `website/privacy.html` once the website is hosted)
Terms of service URL: the public URL of `TERMS.md` in this folder

## Data safety answers (for the APKPure build, 1.9.10, built without Firebase)

- Data collected by the developer: none. The app has no Google sign-in and no
  push service in this build, and the server's usage reporting is off.
- Data transmitted to the user's own Automa server: files and docs the user
  picks (optional), in-app actions, and a random installation ID that
  recognizes the phone.
- Data transmitted from the user's server: chat messages, agent instructions
  and attachments go to the AI model the user picked (the free AI service, or
  the provider whose key the user added); web searches go to DuckDuckGo (or Bing when DuckDuckGo refuses); pages
  agents read are fetched from their own sites.
- Encrypted in transit: yes to the AI providers and the web; to the user's own
  server, yes when it uses HTTPS (on the phone, traffic never leaves the phone).
- Users can delete data: yes, in the app (chats, tasks, files, agents,
  organizations) and by uninstalling the app and Termux.
- No advertising, no analytics SDKs, no selling of data.

## Content rating

Answer the questionnaire as a utility/business app with no user-generated
public content, no violence and no gambling. Chats are with AI models; the
free models are run by their makers under their own terms.

## Assets in this folder

- `app-icon-512.png`: 512×512 icon, 24-bit PNG (the launcher glyph on black)
- `feature-graphic-1024x500.png`: 1024×500 feature graphic, 24-bit PNG without
  alpha (`feature-graphic-1024x500.jpg` is the same graphic as JPEG)
- `screenshots/phone/*.png`: 1080×2400 phone screenshots (the 1.9.7 interface, unchanged since)
- `screenshots/tablet/*.png`: 1920×1200 tablet screenshots (older UI)
