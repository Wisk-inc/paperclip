import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createFcmPushSender, fcmMessageFor, loadFirebaseServiceAccount } from "../services/push-notifications.js";
import { isStaleRunOutcome, pushMessageForActivity, pushMessageForRunOutcome, pushMessageForStudioReply } from "../services/push-notifier.js";

const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const account = {
  project_id: "automa-agent",
  client_email: "push@automa-agent.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};

function fakeGoogle(fcmStatus: (token: string) => number) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    if (target.startsWith("https://oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "access-1", expires_in: 3600 }));
    }
    const body = JSON.parse(String(init?.body)) as { message: { token: string } };
    const status = fcmStatus(body.message.token);
    return new Response(status === 404 ? JSON.stringify({ error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }) : "{}", { status });
  });
}

describe("createFcmPushSender", () => {
  it("is off without a service account", async () => {
    const sender = createFcmPushSender({ account: null });
    expect(sender.enabled).toBe(false);
    await expect(sender.send(["t"], { title: "x", body: "y" })).resolves.toEqual({ sent: 0, invalidTokens: [] });
  });

  it("signs in as the service account, sends one HTTP v1 message per token, and reports dead tokens", async () => {
    const fetchImpl = fakeGoogle((token) => (token === "gone" ? 404 : 200));
    const sender = createFcmPushSender({ account, fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await sender.send(["phone-1", "gone", "phone-1"], { title: "Ada needs a file", body: "Q3 report", path: "/device-files" });
    expect(result).toEqual({ sent: 1, invalidTokens: ["gone"] });

    const tokenCall = fetchImpl.mock.calls.find(([url]) => String(url).includes("oauth2.googleapis.com"))!;
    const assertion = new URLSearchParams(String(tokenCall[1]!.body)).get("assertion")!;
    const claims = JSON.parse(Buffer.from(assertion.split(".")[1]!, "base64url").toString());
    expect(claims).toMatchObject({ iss: account.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging" });

    const sendCall = fetchImpl.mock.calls.find(([url]) => String(url).includes("fcm.googleapis.com"))!;
    expect(String(sendCall[0])).toBe("https://fcm.googleapis.com/v1/projects/automa-agent/messages:send");
    expect((sendCall[1]!.headers as Record<string, string>).authorization).toBe("Bearer access-1");
    expect(JSON.parse(String(sendCall[1]!.body)).message).toEqual({
      token: "phone-1",
      data: { title: "Ada needs a file", body: "Q3 report", path: "/device-files" },
      android: { priority: "HIGH" },
    });
  });

  it("reuses the access token until it is about to expire", async () => {
    let now = 0;
    const fetchImpl = fakeGoogle(() => 200);
    const sender = createFcmPushSender({ account, fetchImpl: fetchImpl as unknown as typeof fetch, nowMs: () => now });
    await sender.send(["a"], { title: "t", body: "b" });
    now = 30 * 60 * 1000;
    await sender.send(["a"], { title: "t", body: "b" });
    const tokenCalls = () => fetchImpl.mock.calls.filter(([url]) => String(url).includes("oauth2")).length;
    expect(tokenCalls()).toBe(1);
    now = 60 * 60 * 1000;
    await sender.send(["a"], { title: "t", body: "b" });
    expect(tokenCalls()).toBe(2);
  });
});

describe("loadFirebaseServiceAccount", () => {
  it("reads the account from a file path or inline JSON, and stays off otherwise", () => {
    const json = JSON.stringify(account);
    expect(loadFirebaseServiceAccount({ AUTOMA_FIREBASE_SERVICE_ACCOUNT_FILE: "/secret/sa.json" }, () => json)?.project_id).toBe("automa-agent");
    expect(loadFirebaseServiceAccount({ AUTOMA_FIREBASE_SERVICE_ACCOUNT_JSON: json })?.client_email).toBe(account.client_email);
    expect(loadFirebaseServiceAccount({})).toBeNull();
    expect(loadFirebaseServiceAccount({ AUTOMA_FIREBASE_SERVICE_ACCOUNT_JSON: "{}" })).toBeNull();
  });
});

describe("notification paths name their organization", () => {
  it("opens the organization the news is about, not the one selected last", () => {
    expect(pushMessageForActivity({ action: "device_file_request.created", details: { title: "Q3.pdf", deviceId: "d1" } }, "Linus", "BETA")?.message.path).toBe(
      "/BETA/device-files?tab=requests",
    );
    expect(pushMessageForActivity({ action: "approval.created", entityId: "ap-1", details: { type: "hire_agent" } }, "Ada", "BETA")?.message).toEqual({
      title: "Approval needed",
      body: "Hire agent from Ada is waiting on you.",
      path: "/BETA/approvals/ap-1",
      tag: "approval:ap-1",
    });
    expect(pushMessageForRunOutcome({ runId: "r1", issueId: "i1", status: "succeeded", finalText: "Done" }, "Ada", "BETA")?.path).toBe("/BETA/issues/i1");
    expect(pushMessageForStudioReply({ workspaceId: "w1", projectName: "Todo", text: "Built it.", error: null, prefix: "BETA" }).path).toBe("/BETA/studio/w1");
  });
});

describe("pushMessageForActivity", () => {
  it("words file requests for the target device and approvals for every device", () => {
    expect(pushMessageForActivity({ action: "device_file_request.created", details: { title: "Q3 revenue.pdf", deviceId: "d1" } }, "Linus")).toEqual({
      deviceId: "d1",
      message: { title: "Linus needs a file", body: "Q3 revenue.pdf", path: "/device-files?tab=requests" },
    });
    expect(pushMessageForActivity({ action: "approval.created", details: { type: "hire_agent" } }, "Ada")).toEqual({
      deviceId: null,
      message: { title: "Approval needed", body: "Hire agent from Ada is waiting on you.", path: "/approvals" },
    });
    expect(pushMessageForActivity({ action: "issue.updated" }, null)).toBeNull();
  });
});

describe("finished work", () => {
  it("words an agent's reply to a person, its failures, and nothing for stopped runs", () => {
    expect(pushMessageForRunOutcome({ runId: "r1", issueId: "i1", status: "succeeded", finalText: "## Done\n\nThe **page** is live: [open](http://x)." }, "Ada")).toEqual({
      title: "Ada replied",
      body: "Done The page is live: open.",
      path: "/issues/i1",
      tag: "issue:i1",
      awayOnly: true,
    });
    expect(pushMessageForRunOutcome({ runId: "r2", issueId: "i1", status: "succeeded" }, null)?.title).toBe("Your agent finished");
    expect(pushMessageForRunOutcome({ runId: "r3", issueId: "i1", status: "failed", error: "Out of credits" }, "Ada")).toMatchObject({ title: "Ada couldn't finish", body: "Out of credits" });
    expect(pushMessageForRunOutcome({ runId: "r4", issueId: "i1", status: "cancelled" }, "Ada")).toBeNull();
    expect(pushMessageForRunOutcome({ runId: "r5", status: "succeeded" }, "Ada")).toBeNull();
  });

  it("leaves out outcomes that finished long ago (sent again after a restart)", () => {
    const now = Date.parse("2026-10-30T12:00:00.000Z");
    expect(isStaleRunOutcome({ finishedAt: "2026-10-30T11:40:00.000Z" }, now)).toBe(true);
    expect(isStaleRunOutcome({ finishedAt: "2026-10-30T11:58:00.000Z" }, now)).toBe(false);
    expect(isStaleRunOutcome({}, now)).toBe(false);
  });

  it("words App Studio replies with the project", () => {
    expect(pushMessageForStudioReply({ workspaceId: "w1", projectName: "Todo", text: "Built the page.", error: null })).toEqual({
      title: "App Studio · Todo",
      body: "Built the page.",
      path: "/studio/w1",
      tag: "studio:w1",
      awayOnly: true,
    });
  });

  it("sends everything as data for the app to show, naming the registration it is for", () => {
    expect(fcmMessageFor("t1", { title: "Ada replied", body: "Hi", path: "/issues/i1", tag: "issue:i1", awayOnly: true }, "device-1")).toEqual({
      token: "t1",
      data: { path: "/issues/i1", tag: "issue:i1", title: "Ada replied", body: "Hi", away_only: "1", device_id: "device-1" },
      android: { priority: "HIGH" },
    });
    // The app decides: a server it forgot gets no notification, and a tap opens the right server.
    expect(fcmMessageFor("t1", { title: "Approval needed", body: "Waiting", path: "/approvals" })).toEqual({
      token: "t1",
      data: { title: "Approval needed", body: "Waiting", path: "/approvals" },
      android: { priority: "HIGH" },
    });
  });

  it("sends each phone the registration it belongs to", async () => {
    const fetchImpl = fakeGoogle(() => 200);
    const sender = createFcmPushSender({ account, fetchImpl: fetchImpl as unknown as typeof fetch });
    await sender.send([{ token: "a", deviceId: "dev-a" }, { token: "b", deviceId: "dev-b" }, "a"], { title: "t", body: "b" });
    const bodies = fetchImpl.mock.calls
      .filter(([url]) => String(url).includes("fcm.googleapis.com"))
      .map(([, init]) => JSON.parse(String(init!.body)).message as { token: string; data: Record<string, string> });
    expect(bodies.map((message) => [message.token, message.data.device_id]).sort()).toEqual([["a", "dev-a"], ["b", "dev-b"]]);
  });
});
