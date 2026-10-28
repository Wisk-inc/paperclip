import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTOMA_ABOUT_FOR_AGENTS, MOAN_MODEL_ID } from "@paperclipai/shared";

const script = fileURLToPath(new URL("../scripts/terminals/free-chat.mjs", import.meta.url));
const serverDir = fileURLToPath(new URL("../../..", import.meta.url));

// Stands in for the free-model service: records each request and streams one short reply.
const FETCH_STUB = `
import { appendFileSync } from "node:fs";
globalThis.fetch = async (_url, init) => {
  appendFileSync(process.env.FREE_CHAT_CAPTURE, init.body + "\\n");
  const lines = [{ type: "text", text: "stub reply" }, { type: "usage", usage: { prompt: 1, completion: 1 } }];
  return new Response(lines.map((line) => JSON.stringify(line)).join("\\n") + "\\n", { headers: { "content-type": "application/x-ndjson" } });
};
`;

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "free-chat-"));
  await writeFile(path.join(dir, "fetch-stub.mjs"), FETCH_STUB);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function systemPromptSent(args: string[]) {
  const capture = path.join(dir, `capture-${args.join("-").replace(/\W+/g, "_") || "default"}.ndjson`);
  const child = spawn(process.execPath, ["--import", pathToFileURL(path.join(dir, "fetch-stub.mjs")).href, script, ...args], {
    cwd: serverDir,
    env: { ...process.env, FREE_CHAT_CAPTURE: capture, PUTER_AUTH_TOKEN: "test-token" },
  });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (out += chunk));
  child.stdin.end("Who made this app?\n");
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  expect(out).toContain("stub reply");
  expect(code).toBe(0);
  const request = JSON.parse((await readFile(capture, "utf8")).trim().split("\n")[0]!);
  const messages = request.args.messages as Array<{ role: string; content: string }>;
  expect(messages.at(-1)).toEqual({ role: "user", content: "Who made this app?" });
  expect(messages[0]!.role).toBe("system");
  return messages[0]!.content;
}

describe("Terminals free chat", () => {
  it("tells the model who made Automa", async () => {
    const system = await systemPromptSent([]);
    expect(system).toContain("You are a helpful assistant in a terminal.");
    expect(system).toContain(AUTOMA_ABOUT_FOR_AGENTS);
  }, 30_000);

  it("tells Moan too, after its own persona", async () => {
    const system = await systemPromptSent(["--model", MOAN_MODEL_ID]);
    expect(system).toContain("Jamaican Patois is your default");
    expect(system.endsWith(AUTOMA_ABOUT_FOR_AGENTS)).toBe(true);
  }, 30_000);
});
