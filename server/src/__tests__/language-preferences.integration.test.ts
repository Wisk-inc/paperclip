/**
 * A person's language (Auto or chosen) against a migrated Postgres: saved and
 * merged field by field, read back for replies, and only for board users.
 */
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, userLanguagePreferences } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { languagePreferenceRoutes } from "../routes/language-preferences.js";
import { languagePreferenceService, replyLanguageNote, replyLanguageOf } from "../services/language-preferences.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("language preferences", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-language-preferences-");
    db = createDb(database.connectionString);
  }, 30_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  function app(actor: Record<string, unknown>) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      req.actor = actor as never;
      next();
    });
    server.use("/api", languagePreferenceRoutes(db));
    server.use(errorHandler);
    return server;
  }

  const board = (userId: string) => ({ type: "board", userId, source: "session", isInstanceAdmin: false, companyIds: [] });

  it("is Auto with nothing detected until the person saves something", async () => {
    const res = await request(app(board("user-new"))).get("/api/language-preferences/me");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ language: "auto", detectedLanguage: null, detectedLocale: null, country: null, timeZone: null, updatedAt: null });
  });

  it("saves what Auto detected, then a choice, each without losing the other", async () => {
    const server = app(board("user-1"));
    const detected = await request(server)
      .put("/api/language-preferences/me")
      .send({ detectedLanguage: "es", detectedLocale: "es-MX", country: "MX", timeZone: "America/Mexico_City" });
    expect(detected.status).toBe(200);
    expect(detected.body).toMatchObject({ language: "auto", detectedLanguage: "es", detectedLocale: "es-MX", country: "MX", timeZone: "America/Mexico_City" });

    const chosen = await request(server).put("/api/language-preferences/me").send({ language: "ja" });
    expect(chosen.body).toMatchObject({ language: "ja", detectedLanguage: "es", country: "MX" });
    expect(Date.parse(chosen.body.updatedAt)).toBeGreaterThan(0);

    const read = await request(server).get("/api/language-preferences/me");
    expect(read.body).toMatchObject({ language: "ja", detectedLocale: "es-MX", timeZone: "America/Mexico_City" });
    // One row per person.
    expect(await db.select().from(userLanguagePreferences)).toHaveLength(1);
  });

  it("refuses a language Automa does not have and anything malformed", async () => {
    const server = app(board("user-2"));
    for (const body of [
      { language: "klingon" },
      { language: "pt" },
      { detectedLanguage: "auto" },
      { country: "jm" },
      { country: "JAM" },
      { detectedLocale: "<script>" },
      { timeZone: "America/../../etc" },
      { language: "es", isInstanceAdmin: true },
    ]) {
      const res = await request(server).put("/api/language-preferences/me").send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await request(server).get("/api/language-preferences/me")).body.language).toBe("auto");
  });

  it("is for signed-in board users only", async () => {
    const agent = await request(app({ type: "agent", agentId: "agent-1", companyId: "company-1" })).get("/api/language-preferences/me");
    expect(agent.status).toBe(403);
    const noUser = await request(app({ type: "board", source: "session", companyIds: [] })).put("/api/language-preferences/me").send({ language: "fr" });
    expect(noUser.status).toBe(403);
  });

  it("gives agents the chosen language, or Auto's, and reads a code it does not know as Auto", async () => {
    const svc = languagePreferenceService(db);
    await svc.update("user-3", { detectedLanguage: "fr", country: "HT", timeZone: "America/Port-au-Prince" });
    expect(await svc.replyLanguage("user-3")).toEqual({ language: "fr", country: "HT", timeZone: "America/Port-au-Prince" });
    await svc.update("user-3", { language: "es" });
    expect((await svc.replyLanguage("user-3"))?.language).toBe("es");
    expect(await svc.replyLanguage("nobody")).toBeNull();
    expect(await svc.replyLanguage(null)).toBeNull();

    await db.insert(userLanguagePreferences).values({ userId: "user-4", language: "xx-future" });
    expect((await svc.get("user-4")).language).toBe("auto");
  });
});

describe("the note agents get", () => {
  it("names the language and the country, and keeps code and quotes as they are", () => {
    const note = replyLanguageNote({ language: "es", country: "MX", timeZone: "America/Mexico_City" });
    expect(note).toContain("uses Automa in Spanish (Español), in Mexico.");
    expect(note).toContain("Their time zone is America/Mexico_City.");
    expect(note).toContain("in Spanish (Español). If they write to you in another language, answer in that language.");
    expect(note).toContain("Keep code, commands, file names, identifiers and quoted text as they are.");
    expect(replyLanguageNote({ language: "en", country: null, timeZone: null })).toMatch(/^The person you are answering uses Automa in English\. Write/);
  });

  it("knows nothing for Auto before a device reported", () => {
    expect(replyLanguageOf({ language: "auto", detectedLanguage: null, detectedLocale: null, country: null, timeZone: null, updatedAt: null })).toBeNull();
  });
});
