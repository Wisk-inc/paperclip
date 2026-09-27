# Device Files

Status: implemented (server, UI, Android app)
Date: 2026-09-27

Device Files let agents pull files from the devices a company's operators use
(the Automa Android app or a browser tab) and send files back to them.

## Model

| Table | Purpose |
|---|---|
| `company_devices` | A phone or browser a board user connected. Idempotent per install (`client_key`). Optionally shares one folder: `shared_folder_name`, `shared_index` (listing, max 5000 entries), `auto_fulfill`. |
| `device_files` | A stored file (backed by `assets` + storage) that came from a device (`source_device_id`) or that an agent sent to one (`target_device_id`). Optional `issue_id`, `device_path`, `note`. |
| `device_file_requests` | An agent or board user asking a device (or any device) for a file: `title`, `details`, optional `device_path`, `accept_types`, `issue_id`; `status` pending → fulfilled/declined/cancelled. |

All rows are company-scoped and cascade with the company.

## Consent model

- Only board users register devices, report shared-folder listings, and
  answer requests. Agents can list devices and files, read a device's shared
  listing, create/cancel their own requests, upload files *to* a device, and
  delete files they uploaded.
- A file leaves a device only when a person picks it, or when the person
  shared the folder **and** turned on auto-send for that device. Auto-send
  runs in the Android app while it is open (`DeviceFilesSync`), and only for
  requests whose `device_path` is in the current listing.
- Device paths are relative, `/`-separated, and reject `.`/`..` segments.
- Fulfilment is a conditional update (`status = 'pending'`), so two devices
  answering at once cannot both succeed; the loser gets 409.
- Downloads of non-inline types are served as attachments with
  `Content-Security-Policy: sandbox`.

## Agent wake-ups

Fulfilling or declining a request made by an agent wakes that agent with
reason `device_file_request_fulfilled` / `device_file_request_declined` and
context `{ deviceFileRequestId, deviceFileId, deviceFileContentPath, issueId }`.

## API

See `skills/paperclip/references/device-files.md` for the agent-facing guide
and `GET /api/openapi.json` (tag `device-files`) for the full contract.

| Method | Path | Who |
|---|---|---|
| GET | `/api/companies/:companyId/devices` | board, agent |
| POST | `/api/companies/:companyId/devices` | board |
| GET | `/api/companies/:companyId/device-files/overview` | board, agent |
| GET / PATCH / DELETE | `/api/devices/:deviceId` | read: both; write: board |
| POST | `/api/devices/:deviceId/heartbeat` | board |
| PUT | `/api/devices/:deviceId/shared-index` | board |
| GET / POST | `/api/companies/:companyId/device-files` | both (agents cannot set `sourceDeviceId`) |
| GET / DELETE | `/api/device-files/:fileId` | both (agents delete only their uploads) |
| GET | `/api/device-files/:fileId/content` | both |
| GET / POST | `/api/companies/:companyId/device-file-requests` | both |
| GET | `/api/device-file-requests/:requestId` | both |
| POST | `/api/device-file-requests/:requestId/fulfill` | board (multipart `file`) |
| POST | `/api/device-file-requests/:requestId/decline` | board |
| POST | `/api/device-file-requests/:requestId/cancel` | requester agent or board |

Every mutation writes an activity-log entry (`device.*`, `device_file.*`,
`device_file_request.*`).

## UI

`/device-files` ("Files" in the phone tab bar and the sidebar): connect this
device, share a folder (Android app), requests waiting on you, files sent to
this device, all files, and devices. The Android bridge contract lives in
`ui/src/lib/automa-native.ts` and `mobile/android/.../AutomaBridge.kt`.
