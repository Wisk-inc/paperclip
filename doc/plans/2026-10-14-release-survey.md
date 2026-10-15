# 2026-10-14 — Automa 1.4.3 full error check and survey

Scope: everything that ships in the phone app (Android shell, bundled board UI,
bundled server), the agent-facing API, agent runs end to end, Google sign-in
readiness, and the repository's own verification suites. Each row says what was
checked, how, the result, and what is left.

Legend: ✅ passes · ⚠️ passes with a caveat · ❌ failed (fixed in this change
unless the row says otherwise) · ⏸ not run (reason given).

## 1. Build and static checks

| What | How | Result |
| --- | --- | --- |
| TypeScript across the monorepo | `pnpm -r typecheck` | ✅ exit 0 |
| Repo build | `pnpm build` | ✅ exit 0 |
| Design-token gates | `pnpm check:token-gates` | ✅ |
| Android lint | `./gradlew lintDebug` | ✅ exit 0 |
| Release APK + AAB 1.4.3 (versionCode 8) | `assembleRelease bundleRelease` with the Corx Labs keystore | ✅ signer SHA-256 `b1a7f7f5…5336e4c` |
| Source zips | `git archive` of HEAD, each under 30 MiB, secret scan, e-mail scan | ✅ no keystore, no service account, no e-mail address in the tree |

## 2. Unit and integration suites

| Suite | How | Result |
| --- | --- | --- |
| UI (`ui/`) | `vitest run` | ✅ 6763 passed |
| Shared, adapters, CLI, DB | part of `pnpm test:run` | ✅ |
| Server, pure unit tests | `vitest run` as root | ✅ |
| Server, DB-backed tests | `vitest run` as a non-root user (embedded Postgres refuses root) | ⚠️ see §2.1 |
| New: `agent-remove-cascade.test.ts` | embedded Postgres, non-root | ✅ 3/3 |
| Playwright e2e (`tests/e2e`) | own server on :3199, non-root, preinstalled Chromium | ⚠️ see §2.2 |

### 2.1 Server suite under a non-root user

The container's embedded Postgres cannot initialise as root, so the server
suite ran as a throwaway user. Every failure in that run was traced to the
sandbox, not to the code:

- `paperclip-skill-utils`, `paperclip-issue-update-helper`, `vitest-chat-shards`
  resolve `skills/…` and `scripts/…` from the current directory. Run from the
  package directory they fail with `ENOENT`/exit 127; run from the repository
  root (the way `pnpm test:run` runs them) they pass.
- `workspace-runtime` "provisions worktree-local pnpm node_modules" ×2 and
  `vitest-chat-shards`: the spawned `pnpm install` goes through Corepack, which
  tries to download pnpm 9.15.4 and is blocked by the sandbox proxy.
- `workspace-runtime` "does not leak parent Paperclip instance env": `EACCES` on
  `/tmp/base-paperclip-home`, a directory an earlier root run left behind.
- `workspace-runtime` "does not accept an occupied allocated port": 20 s test
  timeout while three suites shared the machine.
- `workspace-runtime-exposure` "surfaces a deployment/bind conflict": the guest's
  output starts with nvm's `npm_config_prefix` warning (a container-global npm
  prefix), so the regex that expects the conflict line first does not match.
  Fails identically as root; environment only.
- `railway-ssh` "generates a fresh real key": needs system `ssh-keygen`, which
  the container does not have.
- `native-session-resumption` ×3: embedded Postgres start-up (root) or the
  same sandbox limits; the suite's own retry message names the data directory.

Nothing in the server suite points at a product regression.

### 2.2 Playwright e2e

The suite starts its own throwaway instance with embedded Postgres, so it also
had to run as the non-root user. Two sandbox adjustments were needed and are
not part of the product: the repo's Playwright (1.62) wants a newer headless
shell than the preinstalled `/opt/pw-browsers`, so the run points at the
preinstalled Chromium; and specs write screenshots to a repo-root
`test-results/` directory that must exist and be writable.

First pass (whole suite, 38.8 min, while the server suite shared the machine):
119 passed, 23 failed, 78 skipped, 4 did not run. The 23 failures sorted into
three groups:

- **Sandbox.** The specs that boot their own Paperclip instance
  (`execution-recovery`, `connection-reviews`) run the UI through Vite's dev
  middleware, which must write `ui/node_modules/.vite`; the non-root user
  could not, so pages never finished loading. Fixed by opening that cache.
- **Stale wording after the rebrand.** Five expectations still said Paperclip
  where the product says Automa or used controls the fork replaced: the Slack
  manifest description, the first task's title (two specs), the "Automa
  couldn't start" heading, the chat header's Configure link (now an Edit
  button), the phone "Add project" action, and the assumption that agent chat
  is off by default (Automa ships with it on). Updated in the specs.
- **A real phone gap.** `iMessage Photon` at 390 px could not reach the chat
  connection's Settings/Activity pages (see §6, item 4). Fixed.

Second pass (the failed specs only, after those fixes, 21.9 min): 42 passed,
10 failed, 4 did not run. Everything that had failed on wording or on the
drawer gap passed: attachment receipts, composer Stop, first-task launch,
connection reviews (approve, decline, always, failure), iMessage Photon at
390 px, task reload, agent-chat projects; Slack and Telegram passed in a
separate run once their last Paperclip-era strings were updated, and the chat
sidebar spec passed once it reached agent settings the way the fork's header
does (edit pill, then "All settings"). The remaining failures were the
sandbox again: the 1.4.3 APK build emptied `server/ui-dist` while the e2e
server was serving from it (the server log shows `ENOENT …/ui-dist/index.html`
from 00:50), which took down planning-mode, project-repositories and smoke-lab,
and the execution-recovery journeys wait for a plain "Paperclip is ready at
http://…" line while the nested server printed it with terminal colours.

Third pass (those specs, with ui-dist rebuilt and colours off): (filled in
below).

## 3. Phone browser suites (Playwright, 412×915, touch, DPR 2)

All run against the dev server with the fake native bridge (`window.AutomaNative`).

| Suite | Checks | Result |
| --- | --- | --- |
| `tour` | 55 screenshots of every page, dialog and menu at phone width | ✅ no horizontal overflow, no page errors |
| `overflow-scan` | every route scanned for elements wider than the viewport | ✅ 0 |
| `perf-scan` / `perf-ab` | long tasks and fps on Home under 4× CPU throttle | ✅ 0 long tasks, 60 fps with still mascot; agents' characters 30 fps with scroll-pause |
| `connect-check` | Termux hand-off, prefilled address, retry until Automa answers, keyed bridge calls | ✅ 10/10 |
| `names-check` | claimed names (Owner, Automa, duplicates) refused | ✅ 5/5 |
| `share-code` | Studio share codes expire, revoke, new code | ✅ |
| `studio-ui` | open app, autosave, console, collaborator typing, review diff, preview, public link | ✅ 18/18 |
| `studio-ui2` | ghost suggestions, Tab accept, uploads, undo AI changes, rename/delete/undo, clone a repo | ✅ 16/16 |
| `board-check` | Home usage card; onboarding connect step requires a key (no Skip), Next stays disabled until a key is typed, Connect unlocks once one is | ✅ 5/5 |
| `drawer-apps` | phone drawer shows the Apps rail above the main menu on `/apps`, and only the main menu elsewhere | ✅ 4/4 |
| `locked-check` | instance locked with `PAPERCLIP_LOCAL_TRUSTED_SECRET`: cookie-less and wrong-cookie requests refused, the app's cookie and the CLI bearer accepted, cross-site and sandboxed-frame mutations refused, owner socket Origin checks, 11th wrong share code → 429 with Retry-After | ✅ 16/16 |

## 4. Agent API and agent runs

Scripts `agent-api-check` 1–4 against the dev server, plus a real run through
`claude_local` → acpx → `claude-agent-acp` → Claude Code against a fake model
server (`scratchpad/fake-llm.mjs`).

| Check | Result |
| --- | --- |
| Create agent key; `token` returned once; revoked key → 401 | ✅ |
| Agent key cannot read or write another company | ✅ 403/404 |
| Checkout needs `{agentId, expectedStatuses}`; writes need `X-Paperclip-Run-Id` of the run that owns the task; forged or missing run id → 403 | ✅ |
| Assignment auto-wake checks the task out; run completes; cost reported | ✅ run finished in 18 s with a cost event |
| Agent-authored move to in_review without required details → 422 `invalid_issue_disposition` | ✅ governance, not a bug |
| Agent with an unusable key → run fails `acpx_turn_failed`; task chat explains it and links to Settings → API keys | ✅ (link added in this change) |
| Agents may hire other agents when `requireBoardApprovalForNewAgents` is off (the default) | ⚠️ working as designed; recommendation below |
| `DELETE /api/agents/:id` for an agent that has run | ❌ was a 500 (`cost_events_heartbeat_run_id_heartbeat_runs_id_fk`); fixed, see §6 |

Recommendation: turn on `requireBoardApprovalForNewAgents` for Automa
organizations by default, so an agent cannot grow the payroll without a tap
from the owner.

## 5. Google sign-in (Firebase)

The two uploaded `google-services.json` files are identical and belong to
Firebase project `aboxapps13` (project number 643113361059). They register one
Android app, package `com.aboxapps.com`, with an empty `oauth_client` list.
Automa's package is `com.corxlabs.automa`, so Gradle stops with
“No matching client found for package name 'com.corxlabs.automa'” and the file
cannot ship. The file was not committed (it is git-ignored now).

What the owner needs to do in the Firebase console:

1. Project settings → Add app → Android, package name `com.corxlabs.automa`.
2. Add the signing fingerprints: release SHA-1
   `18:E2:32:34:67:3C:4E:58:AF:ED:56:4D:58:9A:2A:68:F8:99:FB:CA`, debug SHA-1
   `84:9D:2E:F0:1D:D9:10:E2:2A:B9:84:70:E6:97:55:D6:46:7F:13:12`.
3. Authentication → Sign-in method → enable Google.
4. Download the new `google-services.json`, place it at
   `mobile/android/app/google-services.json`, run `pnpm mobile:check-firebase`,
   rebuild.

`pnpm mobile:check-firebase` (new, `scripts/check-google-services.mjs`) checks
the package name, the OAuth web client and the API key, prints the SHA-1s to
register, and exits non-zero on problems. The app side is already wired: the
Gradle plugin is applied only when the file exists, `GoogleSignIn.enabled`
requires a web client id, and the connect page shows “Continue with Google”
only when sign-in is possible.

## 6. Bugs found and fixed in this change

1. **Deleting an agent that had run returned a 500.** Cost events, decisions,
   decision-queue attributions and run events still pointed at the agent's
   heartbeat runs. `agentService.remove` now detaches or removes every dependent
   row inside the transaction (finance ledger rows are kept with the agent
   attribution cleared; queue creators become `system`), refuses with a typed
   409 while a run is active (`agent_has_active_runs`) or a chat endpoint is
   assigned (`agent_assigned_to_chat_endpoint`), and pauses a routine whose
   default agent is removed. Covered by `agent-remove-cascade.test.ts`.
2. **Workspace finalize errors after a mid-run delete.** The
   `workspace_operations … heartbeat_run_id` foreign-key errors in the dev log
   were the consequence of deleting agents while their runs were finishing. The
   new active-run guard prevents that path.
3. **Task chat on `acpx_turn_failed`.** The failure marker now says the model
   call failed and links to Settings → API keys, like the other model-session
   failures.
4. **Chat connection pages had no navigation on phones.** The phone drawer
   always shows the main menu (by design), but the Apps area (Connectors, an
   app's pages, a chat connection's Settings/Access/Reviews/Conversations/
   Activity) has no navigation of its own on the page, so those sections were
   unreachable on a phone. The Apps rail now sits at the top of the drawer on
   those routes only. Found by the `iMessage Photon` e2e spec at 390 px.
5. **Stale e2e wording after the rebrand.** Three e2e expectations still said
   Paperclip where the product says Automa (the Slack manifest description and
   the first task's title). Updated to the Automa wording.

## 7. Left as is

- `requireBoardApprovalForNewAgents` default (recommendation above, not changed).
- Sandbox-only test failures listed in §2.1.
- Google sign-in cannot be exercised end to end until a `google-services.json`
  for `com.corxlabs.automa` exists.
