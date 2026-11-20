import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUTER_DEFAULT_MODEL, PUTER_MODELS } from "@paperclipai/shared/puter-ai";

const script = fileURLToPath(new URL("../scripts/terminals/free-complete.mjs", import.meta.url));
const serverDir = fileURLToPath(new URL("../../..", import.meta.url));
const TOKEN = "bridge-test-token-0123456789";

// Stands in for the free-model service: records each request, then streams a
// reply or refuses, as FREE_STUB_MODE says. A refusal quotes the token, the way
// a service echoing a request might, to prove the bridge never prints it.
const FETCH_STUB = `
import { appendFileSync } from "node:fs";
globalThis.fetch = async (_url, init) => {
  appendFileSync(process.env.FREE_CAPTURE, init.body + "\\n");
  if (process.env.FREE_STUB_MODE === "refuse") {
    return new Response(JSON.stringify({ code: "upstream_auth_failed", message: "only available on another plan (" + process.env.PUTER_AUTH_TOKEN + ")" }), { status: 403 });
  }
  const lines = [{ type: "text", text: '{"status": ' }, { type: "text", text: '"ok"}' }, { type: "usage", usage: { prompt: 9, completion: 4 } }];
  return new Response(lines.map((line) => JSON.stringify(line)).join("\\n") + "\\n", { headers: { "content-type": "application/x-ndjson" } });
};
`;

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "free-complete-"));
  await writeFile(path.join(dir, "fetch-stub.mjs"), FETCH_STUB);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

let runs = 0;
async function bridge(stdin: string, mode = "reply") {
  runs += 1;
  const capture = path.join(dir, `capture-${runs}.ndjson`);
  const child = spawn(process.execPath, ["--import", pathToFileURL(path.join(dir, "fetch-stub.mjs")).href, script], {
    cwd: serverDir,
    env: { ...process.env, FREE_CAPTURE: capture, FREE_STUB_MODE: mode, PUTER_AUTH_TOKEN: TOKEN },
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  child.stdin.end(stdin);
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  const requests = await readFile(capture, "utf8").then(
    (text) => text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    () => [],
  );
  return { code, out, err, reply: JSON.parse(out.trim().split("\n").at(-1)!), requests };
}

describe("IMY free-models bridge", () => {
  it("answers one completion with the system prompt first and the exact model", async () => {
    const model = PUTER_MODELS["deepseek-flash"];
    const { code, reply, requests, out, err } = await bridge(
      JSON.stringify({
        op: "complete",
        model,
        system: "You are the IMY compiler.",
        messages: [
          { role: "user", content: "compile this" },
          { role: "assistant", content: "{}" },
          { role: "user", content: "fix it" },
        ],
        maxTokens: 32000,
        json: true,
      }),
    );
    expect(code).toBe(0);
    expect(reply).toMatchObject({ ok: true, text: '{"status": "ok"}', model });
    expect(requests).toHaveLength(1);
    const sent = requests[0].args;
    expect(sent.model).toBe(model);
    expect(sent.messages).toEqual([
      { role: "system", content: "You are the IMY compiler." },
      { role: "user", content: "compile this" },
      { role: "assistant", content: "{}" },
      { role: "user", content: "fix it" },
    ]);
    expect(out + err).not.toContain(TOKEN);
  }, 30_000);

  it("lists the free models, the default first, without the safety classifier", async () => {
    const { reply } = await bridge(JSON.stringify({ op: "models" }));
    expect(reply.ok).toBe(true);
    const ids = reply.models.map((model: { id: string }) => model.id);
    expect(ids[0]).toBe(PUTER_DEFAULT_MODEL);
    expect(ids).not.toContain(PUTER_MODELS["nemotron-safety"]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(reply.models.every((model: { label: string }) => typeof model.label === "string" && model.label.length > 0)).toBe(true);
  }, 30_000);

  it("reports a refusal by kind and never prints the token", async () => {
    const { code, reply, out, err } = await bridge(
      JSON.stringify({ op: "complete", model: PUTER_MODELS["gemma-31b"], system: "s", messages: [{ role: "user", content: "x" }] }),
      "refuse",
    );
    expect(code).toBe(0);
    expect(reply.ok).toBe(false);
    expect(reply.error.kind).toBe("restricted");
    expect(reply.error.message).toContain("could not answer (403");
    expect(out + err).not.toContain(TOKEN);
  }, 30_000);

  it("rejects requests it can't read without calling the service", async () => {
    const broken = await bridge("not json");
    expect(broken.reply).toMatchObject({ ok: false, error: { kind: "bad_request" } });
    const unknown = await bridge(JSON.stringify({ op: "delete-everything" }));
    expect(unknown.reply).toMatchObject({ ok: false, error: { kind: "bad_request" } });
    const badRole = await bridge(JSON.stringify({ op: "complete", system: "s", messages: [{ role: "system", content: "x" }] }));
    expect(badRole.reply).toMatchObject({ ok: false, error: { kind: "bad_request" } });
    expect([...broken.requests, ...unknown.requests, ...badRole.requests]).toEqual([]);
  }, 30_000);
});
