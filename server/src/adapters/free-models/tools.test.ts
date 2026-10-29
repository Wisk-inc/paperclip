import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PuterHttpError } from "@paperclipai/shared/puter-ai";
import { runFreeTool, type FreeToolContext, type FreeToolToggles } from "./tools.js";

let tmp: string;
let work: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "free-tools-"));
  work = path.join(tmp, "a", "b", "work");
  await fs.mkdir(work, { recursive: true });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(tmp, { recursive: true, force: true });
});

const ALL_ON: FreeToolToggles = { filesAndCommands: true, teammatesAndTasks: true, web: true, connections: true, imageModel: null };

function toolContext(toggles: Partial<FreeToolToggles>, extra: Partial<FreeToolContext> = {}): FreeToolContext {
  return {
    toggles: { ...ALL_ON, ...toggles },
    direct: { cwd: work, env: { ...process.env } as Record<string, string>, apiUrl: "http://automa.test", authToken: "run-token" },
    generateImage: vi.fn(async () => ({ markdown: "![fox](/api/attachments/att-1/content)", attachmentId: "att-1" })),
    saveDocument: vi.fn(async (name: string) => ({ attachmentId: "att-1", name, contentPath: "/api/attachments/att-1/content", downloadPath: "/api/attachments/att-1/content?download=1" })),
    readAttachment: vi.fn(async () => null),
    ...extra,
  };
}

/** Every URL answers with `body`; the stub records each request. */
function stubWeb(body: string | Uint8Array<ArrayBuffer>, contentType = "application/octet-stream") {
  const fetch = vi.fn(async (input: string | URL) => {
    const response = new Response(body, { status: 200, headers: { "content-type": contentType } });
    Object.defineProperty(response, "url", { value: String(input) });
    return response;
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const connections = { rest: { connectionsSearch: "http://automa.test/search", connectionRequest: "http://automa.test/request" }, bearerToken: "t" } as FreeToolContext["runtimeTools"];

describe("free agent tools", () => {
  it("runs only the tools this run offers, whatever the model calls", async () => {
    const fetch = stubWeb("<html><title>Home</title></html>", "text/html");
    // Teammates & tasks on keeps a shell runtime for the Automa tool; Files & commands is off.
    const ctx = toolContext({ filesAndCommands: false, web: false, connections: false }, { runtimeTools: connections });
    expect(await runFreeTool(ctx, "Bash", { command: "echo hacked > hacked.txt" })).toEqual({ content: "The Bash tool is turned off for this agent.", isError: true });
    await expect(fs.access(path.join(work, "hacked.txt"))).rejects.toThrow();
    for (const name of ["Write", "Read", "WebSearch", "WebFetch", "WebCrawl", "WebDownload", "ConnectionsSearch", "ConnectionRequest", "GenerateImage"]) {
      const input = { file_path: "x.txt", content: "x", url: "https://example.com/", query: "x", service: "gmail", prompt: "a fox" };
      expect(await runFreeTool(ctx, name, input)).toEqual({ content: `The ${name} tool is turned off for this agent.`, isError: true });
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(ctx.generateImage).not.toHaveBeenCalled();
    expect(await runFreeTool(ctx, "Teleport", {})).toEqual({ content: "There is no tool named Teleport.", isError: true });

    const noTeammates = toolContext({ teammatesAndTasks: false });
    expect(await runFreeTool(noTeammates, "Automa", { method: "GET", path: "/api/agents/me" })).toEqual({ content: "The Automa tool is turned off for this agent.", isError: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads working-folder and web files only when those tools are on", async () => {
    await fs.writeFile(path.join(work, "notes.txt"), "the secret plans");
    const fetch = stubWeb("from the web", "text/plain");
    const off = toolContext({ filesAndCommands: false, web: false });
    const fromFolder = await runFreeTool(off, "ReadDocument", { path: "notes.txt" });
    expect(fromFolder.isError).toBe(true);
    expect(fromFolder.content).not.toContain("the secret plans");
    expect((await runFreeTool(off, "ReadDocument", { url: "https://example.com/notes.txt" })).isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();

    const on = toolContext({});
    expect((await runFreeTool(on, "ReadDocument", { path: "notes.txt" })).content).toContain("the secret plans");
    expect((await runFreeTool(on, "ReadDocument", { url: "https://example.com/files/notes%20v2.txt" })).content).toContain("# notes v2.txt");
  });

  it("refuses a working-folder file too large to read", async () => {
    const huge = path.join(work, "huge.log");
    await fs.writeFile(huge, "");
    await fs.truncate(huge, 21_000_000);
    const result = await runFreeTool(toolContext({}), "ReadDocument", { path: "huge.log" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("over 20 MB");
    // A device reports no size, so the cap alone would not stop an endless read.
    await fs.symlink("/dev/zero", path.join(work, "zeros.txt"));
    expect(await runFreeTool(toolContext({}), "ReadDocument", { path: "zeros.txt" })).toEqual({ content: "zeros.txt is not a file. List a folder with Glob, then read a file in it.", isError: true });
  });

  it("saves a download bigger than a shell command can carry", async () => {
    const bytes = Uint8Array.from({ length: 300_000 }, (_, index) => index % 251);
    stubWeb(bytes);
    const result = await runFreeTool(toolContext({}), "WebDownload", { url: "https://example.com/files/data.bin" });
    expect(result).toMatchObject({ isError: false });
    expect(result.content).toContain("300,000 bytes) to downloads/data.bin");
    expect(Buffer.from(await fs.readFile(path.join(work, "downloads", "data.bin"))).equals(Buffer.from(bytes))).toBe(true);
  });

  it("keeps a download inside the working folder", async () => {
    stubWeb("echo hi");
    // Four dots name a folder; they are not a way up.
    expect((await runFreeTool(toolContext({}), "WebDownload", { url: "https://example.com/x.sh", path: "....//....//escape.sh" })).content).toContain("to ..../..../escape.sh");
    for (const asked of ["../escape.sh", "/../../escape.sh"]) {
      expect(await runFreeTool(toolContext({}), "WebDownload", { url: "https://example.com/x.sh", path: asked })).toEqual({ content: "The path must be inside the working folder.", isError: true });
    }
    await expect(fs.access(path.join(tmp, "a", "escape.sh"))).rejects.toThrow();
    await expect(fs.access(path.join(tmp, "a", "b", "escape.sh"))).rejects.toThrow();
    // A file name taken from the URL cannot climb out either, and a bad escape in it is not fatal.
    expect((await runFreeTool(toolContext({}), "WebDownload", { url: "https://example.com/x/..%2F..%2Fescape.sh" })).content).toContain("to downloads/escape.sh");
    expect((await runFreeTool(toolContext({}), "WebDownload", { url: "https://example.com/x/100%25%zz.sh" })).content).toContain("to downloads/100%25%zz.sh");
    expect((await runFreeTool(toolContext({}), "WebDownload", { url: "https://example.com/x.sh", path: "/scripts/x.sh" })).content).toContain("to scripts/x.sh");
  });

  it("reads only the start page when the crawl depth is 0", async () => {
    const fetch = stubWeb('<html><title>Home</title><body><a href="/a">A</a><a href="/b">B</a></body></html>', "text/html");
    const result = await runFreeTool(toolContext({}), "WebCrawl", { url: "https://example.com/", depth: 0 });
    expect(result.content).toMatch(/^1 pages:/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("explains a GenerateImage failure in plain words, not the service's raw answer", async () => {
    const ctx = toolContext({ imageModel: "@cf/bytedance/stable-diffusion-xl-lightning" }, {
      generateImage: vi.fn(async () => { throw new PuterHttpError(429, JSON.stringify({ message: "daily limit: try again after 3600" })); }),
    });
    const result = await runFreeTool(ctx, "GenerateImage", { prompt: "a red fox in snow" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("SDXL Lightning");
    expect(result.content).not.toContain("Free model service answered 429");
    expect(result.content).not.toContain("{");
  });
});
