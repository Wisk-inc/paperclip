import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { uiTranslationRoutes } from "../routes/ui-translations.js";
import {
  UI_TRANSLATION_BATCH,
  UI_TRANSLATION_HOURLY_LIMIT,
  acceptUiTranslation,
  parseTranslationReply,
  setSharedUiTranslationServiceForTests,
  uiTranslationMessages,
  uiTranslationService,
} from "../services/ui-translations.js";

const BOARD = new Set(["Sign out", "Save", "Delete {0} files?", "Hello", ...Array.from({ length: 70 }, (_, i) => `Board string ${i}`)]);

/** A fake free model: Spanish-ish translations of whatever array it is given. */
function fakeModel(transform: (source: string) => string = (source) => `ES ${source}`) {
  return vi.fn(async (messages: Array<{ role: string; content: string }>) => {
    const strings = JSON.parse(messages[1]!.content) as string[];
    return `Here you go:\n${JSON.stringify(strings.map(transform))}`;
  });
}

describe("checking a translation", () => {
  it("keeps the placeholders and refuses markup, links and runaway text", () => {
    expect(acceptUiTranslation("Delete {0} files?", "¿Eliminar {0} archivos?")).toBe("¿Eliminar {0} archivos?");
    expect(acceptUiTranslation("Delete {0} files?", "¿Eliminar archivos?")).toBeNull();
    expect(acceptUiTranslation("Delete {0} files?", "¿Eliminar {0} {1} archivos?")).toBeNull();
    expect(acceptUiTranslation("Save", "<b>Guardar</b>")).toBeNull();
    expect(acceptUiTranslation("Save", "Guardar https://evil.example")).toBeNull();
    expect(acceptUiTranslation("Save", "G".repeat(200))).toBeNull();
    expect(acceptUiTranslation("Save", "  Guardar\n ")).toBe("Guardar");
    expect(acceptUiTranslation("Save", 42)).toBeNull();
  });

  it("reads the JSON array out of a reply and refuses the wrong count", () => {
    expect(parseTranslationReply('Sure!\n["Guardar","Salir"]\nDone.', 2)).toEqual(["Guardar", "Salir"]);
    expect(parseTranslationReply('["Guardar"]', 2)).toBeNull();
    expect(parseTranslationReply("no array here", 1)).toBeNull();
  });

  it("asks for the language by name and passes the strings as JSON", () => {
    const messages = uiTranslationMessages("es", ["Save"]);
    expect(messages[0]!.content).toContain("into Spanish (Español)");
    expect(messages[0]!.content).toContain("Keep {0}, {1}");
    expect(messages[1]!.content).toBe('["Save"]');
  });
});

describe("the translation service", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "ui-translations-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("translates board strings once, saves them, and answers from the copy after a restart", async () => {
    const complete = fakeModel();
    const svc = uiTranslationService({ complete, dir: () => dir, boardStrings: BOARD });
    const first = await svc.translate("es", ["Sign out", "Delete {0} files?", "Sign out"], "user-1");
    expect(first).toEqual({ translations: { "Sign out": "ES Sign out", "Delete {0} files?": "ES Delete {0} files?" }, pending: [] });
    expect(complete).toHaveBeenCalledTimes(1);
    await svc.translate("es", ["Sign out"], "user-2");
    expect(complete).toHaveBeenCalledTimes(1);

    const saved = JSON.parse(readFileSync(path.join(dir, "es.json"), "utf8"));
    expect(saved.entries["Sign out"]).toBe("ES Sign out");
    const restarted = uiTranslationService({ complete: fakeModel(), dir: () => dir, boardStrings: BOARD });
    expect(restarted.all("es")).toEqual({ "Sign out": "ES Sign out", "Delete {0} files?": "ES Delete {0} files?" });
  });

  it("never sends what is not the board's own text, and does nothing for English", async () => {
    const complete = fakeModel();
    const svc = uiTranslationService({ complete, dir: () => null, boardStrings: BOARD });
    const result = await svc.translate("fr", ["My secret task about Mary", "Save"], "user-1");
    expect(result).toEqual({ translations: { Save: "ES Save" }, pending: [] });
    expect(JSON.parse(complete.mock.calls[0]![0][1]!.content)).toEqual(["Save"]);
    expect(await svc.translate("en", ["Save"], "user-1")).toEqual({ translations: {}, pending: [] });
  });

  it("leaves strings whose translation fails a check pending, and splits a reply of the wrong shape", async () => {
    const complete = vi.fn(async (messages: Array<{ content: string }>) => {
      const strings = JSON.parse(messages[1]!.content) as string[];
      // Two strings at once: a short answer; one at a time: fine, but the placeholder is dropped.
      if (strings.length > 1) return JSON.stringify(["only one"]);
      return JSON.stringify([strings[0] === "Delete {0} files?" ? "¿Eliminar archivos?" : `DE ${strings[0]}`]);
    });
    const svc = uiTranslationService({ complete, dir: () => null, boardStrings: BOARD });
    const result = await svc.translate("de", ["Save", "Delete {0} files?"], "user-1");
    expect(result).toEqual({ translations: { Save: "DE Save" }, pending: ["Delete {0} files?"] });
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it("asks the model once when two people want the same strings at the same time", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const complete = vi.fn(async (messages: Array<{ content: string }>) => {
      await gate;
      return JSON.stringify((JSON.parse(messages[1]!.content) as string[]).map((s) => `JA ${s}`));
    });
    const svc = uiTranslationService({ complete, dir: () => null, boardStrings: BOARD });
    const both = Promise.all([svc.translate("ja", ["Hello"], "a"), svc.translate("ja", ["Hello"], "b")]);
    finish();
    const [a, b] = await both;
    expect(complete).toHaveBeenCalledTimes(1);
    expect(a.translations).toEqual({ Hello: "JA Hello" });
    expect(b.translations).toEqual({ Hello: "JA Hello" });
  });

  it("splits large requests into batches and stops at a person's hourly allowance", async () => {
    let now = 0;
    const complete = fakeModel();
    const strings = Array.from({ length: 70 }, (_, i) => `Board string ${i}`);
    const svc = uiTranslationService({ complete, dir: () => null, boardStrings: BOARD, now: () => now });
    await svc.translate("it", strings, "user-1");
    expect(complete).toHaveBeenCalledTimes(Math.ceil(70 / UI_TRANSLATION_BATCH));

    const limited = uiTranslationService({ complete: fakeModel(), dir: () => null, boardStrings: BOARD, now: () => now });
    // Use up all but 2 of the hour's allowance on other languages' strings.
    for (let used = 0; used < UI_TRANSLATION_HOURLY_LIMIT - 2; used += 70) {
      const left = UI_TRANSLATION_HOURLY_LIMIT - 2 - used;
      await limited.translate(["pl", "nl", "sv", "da", "fi", "cs", "hu", "ro", "tr", "el", "uk", "ru", "vi", "th", "id", "ms", "sw", "fil", "hi", "bn", "mr", "pa", "ta", "te", "ur", "fa", "he", "ar", "ko", "ja", "zh-CN"][Math.floor(used / 70)] as never, strings.slice(0, Math.min(70, left)), "user-1");
    }
    const capped = await limited.translate("pt-BR", ["Save", "Sign out", "Hello"], "user-1");
    expect(Object.keys(capped.translations)).toHaveLength(2);
    expect(capped.pending).toHaveLength(1);
    now += 60 * 60_000;
    expect((await limited.translate("pt-BR", ["Hello"], "user-1")).translations).toEqual({ Hello: "ES Hello" });
  });
});

describe("translation routes", () => {
  afterEach(() => setSharedUiTranslationServiceForTests(null));

  function app(actor: Record<string, unknown>) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      req.actor = actor as never;
      next();
    });
    server.use("/api", uiTranslationRoutes());
    server.use(errorHandler);
    return server;
  }
  const board = { type: "board", userId: "user-1", source: "session", isInstanceAdmin: false, companyIds: [] };

  it("translates and lists for board users only, with strict input", async () => {
    setSharedUiTranslationServiceForTests(uiTranslationService({ complete: fakeModel(), dir: () => null, boardStrings: BOARD }));
    const posted = await request(app(board)).post("/api/ui-translations").send({ language: "es", strings: ["Save", "not ours"] });
    expect(posted.status).toBe(200);
    expect(posted.body).toEqual({ language: "es", translations: { Save: "ES Save" }, pending: [] });
    const listed = await request(app(board)).get("/api/ui-translations/es");
    expect(listed.body).toEqual({ language: "es", translations: { Save: "ES Save" } });

    expect((await request(app(board)).get("/api/ui-translations/xx")).status).toBe(400);
    expect((await request(app(board)).post("/api/ui-translations").send({ language: "es", strings: [] })).status).toBe(400);
    expect((await request(app(board)).post("/api/ui-translations").send({ language: "es", strings: Array(81).fill("Save") })).status).toBe(400);
    expect((await request(app(board)).post("/api/ui-translations").send({ language: "es", strings: ["Save"], model: "x" })).status).toBe(400);
    const agent = { type: "agent", agentId: "agent-1", companyId: "company-1" };
    expect((await request(app(agent)).post("/api/ui-translations").send({ language: "es", strings: ["Save"] })).status).toBe(403);
    expect((await request(app(agent)).get("/api/ui-translations/es")).status).toBe(403);
  });
});
