import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "../types.js";

vi.mock("../../services/free-models.js", () => ({
  equivalentTokenCostUsd: vi.fn(async () => 0.001),
  equivalentImageCostUsd: (images: number) => images * 0.002,
}));

const { execute } = await import("./execute.js");

const API = "http://automa.test";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64");

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function stubNetwork(chatContent: string) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    calls.push({ url, method, headers: (init.headers ?? {}) as Record<string, string>, body: init.body });
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://api.puter.com/")) {
      const request = JSON.parse(String(init.body)) as { interface: string };
      if (request.interface === "puter-image-generation") return json({ success: true, result: `data:image/png;base64,${JPEG}` });
      return json({ success: true, result: { message: { content: chatContent }, usageDetails: { inputTokens: 40, outputTokens: 60 } } });
    }
    if (url === `${API}/api/issues/issue-1`) return json({ companyId: "company-1", title: "Chat", conversationAgentId: "agent-1" });
    if (url.startsWith(`${API}/api/issues/issue-1/comments`) && method === "GET") {
      // Newest first, as the API answers by default.
      return json([
        { id: "c1", authorType: "user", authorAgentId: null, body: "How many apples are left?" },
        { id: "c0", authorType: "system", authorAgentId: null, body: "Run failed" },
        { id: "a0", authorType: "agent", authorAgentId: "agent-1", body: "Hi, I am Atlas." },
        { id: "u0", authorType: "user", authorAgentId: null, body: "Hello" },
      ]);
    }
    if (url === `${API}/api/issues/issue-1/attachments`) return json([]);
    if (url === `${API}/api/companies/company-1/issues/issue-1/attachments` && method === "POST") {
      return json({ id: "att-1", contentPath: "/api/attachments/att-1/content" });
    }
    if (url === `${API}/api/issues/issue-1/comments` && method === "POST") return json({ id: "reply" });
    return new Response("not found", { status: 404 });
  }));
  return calls;
}

function context(config: Record<string, unknown>, authToken: string | null = "run-token"): AdapterExecutionContext & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    runId: "run-12345678",
    agent: { id: "agent-1", companyId: "company-1", name: "Atlas", adapterType: "free_models", adapterConfig: config },
    runtime: {} as AdapterExecutionContext["runtime"],
    config,
    context: { issueId: "issue-1" },
    authToken: authToken ?? undefined,
    onLog: async (_stream, chunk) => { logs.push(chunk); },
  };
}

beforeEach(() => {
  process.env.PAPERCLIP_API_URL = API;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PAPERCLIP_API_URL;
});

describe("free models adapter", () => {
  it("answers the chat as the agent, shows thinking at a set level, and records free usage", async () => {
    const calls = stubNetwork("<thinking>3 × 12 = 36; 36 − 7 = 29</thinking>\n29 apples.");
    const ctx = context({ model: "deepseek/deepseek-v4.1-flash:free", effort: "high" });
    const result = await execute(ctx);

    const chat = calls.find((call) => call.url.startsWith("https://api.puter.com/"))!;
    const sent = JSON.parse(String(chat.body)) as { args: { model: string; messages: Array<{ role: string; content: string }> } };
    expect(sent.args.model).toBe("deepseek/deepseek-v4.1-flash:free");
    expect(sent.args.messages.map((m) => m.content.slice(0, 12))).toEqual(["You are Atla", "Hello", "Hi, I am Atl", "How many app"]);
    expect(sent.args.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(sent.args.messages[3]!.content).toContain("Think step by step carefully");
    expect(sent.args.messages[1]!.content).not.toContain("Think step by step");
    expect(calls.some((call) => call.url.includes("/comments?order=desc"))).toBe(true);

    const post = calls.find((call) => call.method === "POST" && call.url === `${API}/api/issues/issue-1/comments`)!;
    expect(post.headers.authorization).toBe("Bearer run-token");
    expect(post.headers["x-paperclip-run-id"]).toBe("run-12345678");
    expect(JSON.parse(String(post.body)).body).toBe("> **Thinking**\n>\n> 3 × 12 = 36; 36 − 7 = 29\n\n29 apples.");
    expect(ctx.logs.some((line) => line.startsWith('{"type":"thinking"'))).toBe(true);

    expect(result).toMatchObject({
      exitCode: 0,
      costUsd: 0,
      provider: "free_models",
      usage: { inputTokens: 40, outputTokens: 60 },
      resultJson: { freeUsage: { model: "deepseek/deepseek-v4.1-flash:free", inputTokens: 40, outputTokens: 60, images: 0, equivalentUsd: 0.001 } },
    });
  });

  it("keeps thinking out of the reply on Auto", async () => {
    const calls = stubNetwork("<thinking>quiet</thinking>29 apples.");
    await execute(context({ model: "deepseek/deepseek-v4.1-flash:free" }));
    const post = calls.find((call) => call.method === "POST" && call.url === `${API}/api/issues/issue-1/comments`)!;
    expect(JSON.parse(String(post.body)).body).toBe("29 apples.");
  });

  it("draws with an image model, uploads the picture, and embeds it in the reply", async () => {
    const calls = stubNetwork("unused");
    const result = await execute(context({ model: "@cf/bytedance/stable-diffusion-xl-lightning" }));
    const upload = calls.find((call) => call.url.endsWith("/attachments") && call.method === "POST")!;
    expect(upload.body).toBeInstanceOf(FormData);
    const file = (upload.body as FormData).get("file") as File;
    expect(file.type).toBe("image/jpeg");
    const post = calls.find((call) => call.method === "POST" && call.url === `${API}/api/issues/issue-1/comments`)!;
    expect(JSON.parse(String(post.body))).toEqual({
      body: "![How many apples are left?](/api/attachments/att-1/content)",
      attachmentIds: ["att-1"],
    });
    expect(result.resultJson).toMatchObject({ freeUsage: { images: 1, equivalentUsd: 0.002 } });
  });

  it("explains a missing agent key instead of answering silently", async () => {
    stubNetwork("unused");
    await expect(execute(context({}, null))).rejects.toThrow(/PAPERCLIP_AGENT_JWT_SECRET/);
  });
});
