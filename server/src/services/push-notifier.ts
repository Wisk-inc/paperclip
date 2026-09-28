/**
 * Turns company activity into phone notifications for the Automa Android
 * app: an agent asking a device for a file, and an approval waiting on a
 * person. Listens to the process-wide live event stream, so every route that
 * logs these actions is covered without per-route code.
 */
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import type { LiveEvent } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { deviceFileService } from "./device-files.js";
import { subscribeAllCompanyLiveEvents } from "./live-events.js";
import { pushSender, type PushMessage, type PushSender } from "./push-notifications.js";

type ActivityPayload = {
  action?: string;
  agentId?: string | null;
  details?: Record<string, unknown> | null;
};

function humanizeApprovalType(type: unknown): string {
  if (typeof type !== "string" || type.length === 0) return "A decision";
  const words = type.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function pushMessageForActivity(
  payload: ActivityPayload,
  agentName: string | null,
): { message: PushMessage; deviceId: string | null } | null {
  const details = payload.details ?? {};
  const who = agentName ?? "Someone";
  if (payload.action === "device_file_request.created") {
    return {
      deviceId: typeof details.deviceId === "string" ? details.deviceId : null,
      message: {
        title: `${who} needs a file`,
        body: typeof details.title === "string" ? details.title : "Open Files to answer the request.",
        path: "/device-files?tab=requests",
      },
    };
  }
  if (payload.action === "approval.created") {
    return {
      deviceId: null,
      message: {
        title: "Approval needed",
        body: `${humanizeApprovalType(details.type)} from ${who} is waiting on you.`,
        path: "/approvals",
      },
    };
  }
  return null;
}

export function startPushNotifier(db: Db, push: PushSender = pushSender()): () => void {
  if (!push.enabled) return () => {};
  const devices = deviceFileService(db);

  async function deliver(event: LiveEvent) {
    const payload = event.payload as ActivityPayload;
    if (payload.action !== "device_file_request.created" && payload.action !== "approval.created") return;
    const agentName = payload.agentId
      ? (await db.select({ name: agents.name }).from(agents).where(eq(agents.id, payload.agentId)).limit(1))[0]?.name ?? null
      : null;
    const planned = pushMessageForActivity(payload, agentName);
    if (!planned) return;
    const targets = await devices.listPushTargets(event.companyId, planned.deviceId);
    if (targets.length === 0) return;
    const result = await push.send(targets.map((target) => target.token), planned.message);
    await devices.clearPushTokens(result.invalidTokens);
  }

  return subscribeAllCompanyLiveEvents((event) => {
    if (event.type !== "activity.logged") return;
    deliver(event).catch((error) => {
      logger.warn({ err: error instanceof Error ? error.message : String(error) }, "Push notification failed");
    });
  });
}
