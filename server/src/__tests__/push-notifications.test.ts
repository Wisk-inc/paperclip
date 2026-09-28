import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createFcmPushSender, loadFirebaseServiceAccount } from "../services/push-notifications.js";
import { pushMessageForActivity } from "../services/push-notifier.js";

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
    expect(JSON.parse(String(sendCall[1]!.body)).message).toMatchObject({
      notification: { title: "Ada needs a file", body: "Q3 report" },
      data: { path: "/device-files" },
      android: { priority: "HIGH", notification: { channel_id: "automa_updates" } },
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
