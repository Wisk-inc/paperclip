/**
 * Turns company activity into phone notifications for the Automa Android
 * app: an agent asking a device for a file, an approval waiting on a person,
 * and an agent's reply to something a person asked (shown only while the
 * app is out of sight). Listens to the process-wide live event stream, so
 * every route that logs these actions is covered without per-route code.
 */
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, agents, heartbeatRuns } from "@paperclipai/db";
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

/** Markdown and extra space out, cut for a notification. */
export function notificationSnippet(text: string, max = 240): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~>#|]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

type RunStatusPayload = {
  runId?: unknown;
  agentId?: unknown;
  issueId?: unknown;
  status?: unknown;
  error?: unknown;
  finalText?: unknown;
  finishedAt?: unknown;
};

/** Final statuses are sent again until they surely went out (after a restart, too); old ones are not news. */
const STALE_OUTCOME_MS = 10 * 60 * 1000;
export function isStaleRunOutcome(payload: RunStatusPayload, now = Date.now()): boolean {
  const finishedAt = typeof payload.finishedAt === "string" ? Date.parse(payload.finishedAt) : Number.NaN;
  return Number.isFinite(finishedAt) && now - finishedAt > STALE_OUTCOME_MS;
}

/**
 * The phone notification for a finished run, worded like the board's own;
 * null while it runs, or when the person stopped it.
 */
export function pushMessageForRunOutcome(payload: RunStatusPayload, agentName: string | null): PushMessage | null {
  if (typeof payload.issueId !== "string") return null;
  const who = agentName?.trim() || "Your agent";
  const reply = typeof payload.finalText === "string" && payload.finalText.trim() ? payload.finalText : null;
  let title: string;
  let body: string;
  if (payload.status === "succeeded") {
    title = reply ? `${who} replied` : `${who} finished`;
    body = reply ?? "Open it to see what changed.";
  } else if (payload.status === "failed" || payload.status === "timed_out") {
    title = `${who} couldn't finish`;
    body = (typeof payload.error === "string" && payload.error.trim()) || (payload.status === "timed_out" ? "It ran out of time." : "Open it to see what happened.");
  } else {
    return null;
  }
  return {
    title,
    body: notificationSnippet(body),
    path: `/issues/${payload.issueId}`,
    tag: `issue:${payload.issueId}`,
    awayOnly: true,
  };
}

/** The phone notification for a finished App Studio reply. */
export function pushMessageForStudioReply(input: { workspaceId: string; projectName: string; text: string; error: string | null }): PushMessage {
  const project = input.projectName.trim() || "your project";
  return {
    title: `App Studio · ${project}`,
    body: notificationSnippet(input.error ? `Couldn't finish: ${input.error}` : input.text.trim() || "The team finished. Open it to see the changes."),
    path: `/studio/${input.workspaceId}`,
    tag: `studio:${input.workspaceId}`,
    awayOnly: true,
  };
}

/** The server repeats each final run status until it is sure it went out; each run is told once. */
const toldRuns = new Set<string>();
function firstTellingOf(runId: string): boolean {
  if (toldRuns.has(runId)) return false;
  toldRuns.add(runId);
  if (toldRuns.size > 2_000) toldRuns.delete(toldRuns.values().next().value as string);
  return true;
}

async function agentNameFor(db: Db, agentId: unknown): Promise<string | null> {
  if (typeof agentId !== "string") return null;
  return (await db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId)).limit(1))[0]?.name ?? null;
}

/** Sends `message` to every phone of the company; quiet when push is off. */
async function pushToCompany(db: Db, push: PushSender, companyId: string, message: PushMessage) {
  if (!push.enabled) return;
  const devices = deviceFileService(db);
  const targets = await devices.listPushTargets(companyId, null);
  if (targets.length === 0) return;
  const result = await push.send(targets.map((target) => target.token), message);
  await devices.clearPushTokens(result.invalidTokens);
}

/** A finished App Studio reply, for the person's phones (shown once they are out of the app). */
export async function pushStudioReply(
  db: Db,
  input: { companyId: string; workspaceId: string; projectName: string; text: string; error: string | null },
  push: PushSender = pushSender(),
) {
  try {
    await pushToCompany(db, push, input.companyId, pushMessageForStudioReply(input));
  } catch (error) {
    logger.warn({ err: error instanceof Error ? error.message : String(error) }, "Push notification failed");
  }
}

export function startPushNotifier(db: Db, push: PushSender = pushSender()): () => void {
  if (!push.enabled) return () => {};
  const devices = deviceFileService(db);

  /** Replies only to what a person asked (a message, a manual run): never the agents' own routine work. */
  async function deliverRunOutcome(event: LiveEvent) {
    const payload = event.payload as RunStatusPayload;
    if (typeof payload.runId !== "string" || typeof payload.issueId !== "string") return;
    const message = pushMessageForRunOutcome(payload, null);
    if (!message || isStaleRunOutcome(payload) || !firstTellingOf(payload.runId)) return;
    const [run] = await db
      .select({ askedBy: agentWakeupRequests.requestedByActorType })
      .from(heartbeatRuns)
      .leftJoin(agentWakeupRequests, eq(heartbeatRuns.wakeupRequestId, agentWakeupRequests.id))
      .where(eq(heartbeatRuns.id, payload.runId))
      .limit(1);
    if (run?.askedBy !== "user") return;
    const worded = pushMessageForRunOutcome(payload, await agentNameFor(db, payload.agentId));
    if (worded) await pushToCompany(db, push, event.companyId, worded);
  }

  async function deliver(event: LiveEvent) {
    const payload = event.payload as ActivityPayload;
    if (payload.action !== "device_file_request.created" && payload.action !== "approval.created") return;
    const agentName = await agentNameFor(db, payload.agentId);
    const planned = pushMessageForActivity(payload, agentName);
    if (!planned) return;
    const targets = await devices.listPushTargets(event.companyId, planned.deviceId);
    if (targets.length === 0) return;
    const result = await push.send(targets.map((target) => target.token), planned.message);
    await devices.clearPushTokens(result.invalidTokens);
  }

  return subscribeAllCompanyLiveEvents((event) => {
    const delivery = event.type === "activity.logged" ? deliver(event) : event.type === "heartbeat.run.status" ? deliverRunOutcome(event) : null;
    delivery?.catch((error) => {
      logger.warn({ err: error instanceof Error ? error.message : String(error) }, "Push notification failed");
    });
  });
}
