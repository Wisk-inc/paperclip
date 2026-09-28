/**
 * Push notifications to the Automa Android app through Firebase Cloud
 * Messaging (HTTP v1).
 *
 * Off unless the operator gives the server a Firebase service account:
 *   AUTOMA_FIREBASE_SERVICE_ACCOUNT_FILE=/path/to/service-account.json
 * (or the JSON itself in AUTOMA_FIREBASE_SERVICE_ACCOUNT_JSON). The key never
 * belongs in the repository or the app; keep the file readable only by the
 * server user.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { logger } from "../middleware/logger.js";

export type PushMessage = {
  title: string;
  body: string;
  /** Board path the app opens when the notification is tapped, e.g. "/device-files". */
  path?: string;
};

export type PushSendResult = { sent: number; invalidTokens: string[] };

export interface PushSender {
  readonly enabled: boolean;
  send(tokens: string[], message: PushMessage): Promise<PushSendResult>;
}

type ServiceAccount = { project_id: string; client_email: string; private_key: string; token_uri?: string };

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
/** Must match the notification channel the Android app creates. */
const ANDROID_CHANNEL_ID = "automa_updates";

export function loadFirebaseServiceAccount(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => string = (path) => fs.readFileSync(path, "utf8"),
): ServiceAccount | null {
  const inline = env.AUTOMA_FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  const file = env.AUTOMA_FIREBASE_SERVICE_ACCOUNT_FILE?.trim();
  if (!inline && !file) return null;
  try {
    const parsed = JSON.parse(inline || readFile(file!)) as Partial<ServiceAccount>;
    if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
      logger.warn("Firebase service account is missing project_id, client_email, or private_key; push is off");
      return null;
    }
    return parsed as ServiceAccount;
  } catch (error) {
    logger.warn({ err: error instanceof Error ? error.message : String(error) }, "Could not read the Firebase service account; push is off");
    return null;
  }
}

const disabledSender: PushSender = {
  enabled: false,
  send: async () => ({ sent: 0, invalidTokens: [] }),
};

export function createFcmPushSender(options: {
  account: ServiceAccount | null;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}): PushSender {
  const { account } = options;
  if (!account) return disabledSender;
  const fetchImpl = options.fetchImpl ?? fetch;
  const nowMs = options.nowMs ?? Date.now;
  let accessToken: { value: string; expiresAt: number } | null = null;

  async function getAccessToken(): Promise<string> {
    if (accessToken && accessToken.expiresAt > nowMs() + 60_000) return accessToken.value;
    const iat = Math.floor(nowMs() / 1000);
    const tokenUri = account!.token_uri ?? DEFAULT_TOKEN_URI;
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
      iss: account!.client_email,
      scope: FCM_SCOPE,
      aud: tokenUri,
      iat,
      exp: iat + 3600,
    })}`;
    const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), account!.private_key).toString("base64url");
    const res = await fetchImpl(tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature}`,
      }),
    });
    if (!res.ok) throw new Error(`Google token endpoint answered ${res.status}`);
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error("Google token endpoint returned no access token");
    accessToken = { value: json.access_token, expiresAt: nowMs() + (json.expires_in ?? 3600) * 1000 };
    return accessToken.value;
  }

  return {
    enabled: true,
    async send(tokens, message) {
      const unique = [...new Set(tokens)];
      if (unique.length === 0) return { sent: 0, invalidTokens: [] };
      const bearer = await getAccessToken();
      const url = `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`;
      const invalidTokens: string[] = [];
      let sent = 0;
      await Promise.all(
        unique.map(async (token) => {
          const res = await fetchImpl(url, {
            method: "POST",
            headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
            body: JSON.stringify({
              message: {
                token,
                notification: { title: message.title, body: message.body },
                data: message.path ? { path: message.path } : {},
                android: {
                  priority: "HIGH",
                  notification: { channel_id: ANDROID_CHANNEL_ID },
                },
              },
            }),
          });
          if (res.ok) {
            sent += 1;
            return;
          }
          const text = await res.text().catch(() => "");
          // 404 UNREGISTERED: the app was uninstalled or the token rotated.
          if (res.status === 404 || text.includes("UNREGISTERED") || text.includes("registration-token-not-registered")) {
            invalidTokens.push(token);
            return;
          }
          logger.warn({ status: res.status }, "FCM rejected a push notification");
        }),
      );
      return { sent, invalidTokens };
    },
  };
}

let sharedSender: PushSender | null = null;

/** The process-wide sender, configured from the environment on first use. */
export function pushSender(): PushSender {
  sharedSender ??= createFcmPushSender({ account: loadFirebaseServiceAccount() });
  return sharedSender;
}
