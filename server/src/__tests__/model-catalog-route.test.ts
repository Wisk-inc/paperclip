import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import type { CatalogModel } from "@paperclipai/shared/model-catalog";
import { errorHandler } from "../middleware/index.js";
import { modelCatalogRoutes } from "../routes/model-catalog.js";
import { configureModelCatalogForTests, resetModelCatalogForTests } from "../services/model-catalog.js";

const now = Math.floor(Date.now() / 1000);
function model(id: string, output = ["text"]): CatalogModel {
  return { id, name: id, created: now, context: null, tools: true, input: ["text"], output, price: null };
}

function app(actor: Record<string, unknown>) {
  const server = express();
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use("/api", modelCatalogRoutes());
  server.use(errorHandler);
  return server;
}

describe("GET /api/model-catalog", () => {
  afterEach(() => resetModelCatalogForTests());

  it("lists the major makers' chat models from the catalog the server keeps, newest first", async () => {
    configureModelCatalogForTests({
      fetch: (() => { throw new Error("no download expected"); }) as never,
      savedFile: () => null,
      builtIn: () => ({
        source: "built-in",
        fetchedAt: new Date().toISOString(),
        models: [
          model("google/gemini-4-hydrogen"),
          model("nvidia/nemotron-3-ultra-550b-a55b:free"),
          model("google/gemini-nano-banana-2.1", ["image"]),
          model("someone/obscure-1"),
          model("anthropic/claude-fable-5.2"),
        ],
      }),
    });
    const response = await request(app({ type: "board", userId: "u1", source: "session", companyIds: [] })).get("/api/model-catalog");
    expect(response.status).toBe(200);
    expect(response.body.source).toBe("built-in");
    expect(response.body.models.map((m: CatalogModel) => m.id)).toEqual(["google/gemini-4-hydrogen", "anthropic/claude-fable-5.2"]);
  });

  it("answers agents too, and nobody who is not signed in", async () => {
    configureModelCatalogForTests({ savedFile: () => null, builtIn: () => ({ source: "built-in", fetchedAt: new Date().toISOString(), models: [] }) });
    expect((await request(app({ type: "agent", agentId: "a1", companyId: "c1", source: "agent_key" })).get("/api/model-catalog")).status).toBe(200);
    expect((await request(app({ type: "none", source: "none" })).get("/api/model-catalog")).status).toBe(401);
  });
});
