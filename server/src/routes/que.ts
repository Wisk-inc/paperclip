import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { QUE_CONVERSATION_ID_PATTERN, queBatchSchema, queChatSchema, queConversationMessageSchema, type QueThinkMode } from "@paperclipai/shared";
import {
  queBatch,
  queChat,
  queClearConversation,
  queClearConversations,
  queConversation,
  queConversations,
  queConvo,
  queModelId,
  queStats,
  type QueOptions,
  type QueScope,
} from "@paperclipai/shared/que-engine";
import { badRequest, HttpError, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

interface QueBody {
  model?: string;
  system?: string;
  think?: QueThinkMode;
  cache?: boolean;
  fallback?: boolean;
}

/**
 * The Que engine's routes. Cached answers are shared inside a company;
 * conversations belong to the person or agent that started them. Both live
 * in server memory only, like a scratch pad.
 */
export function queRoutes(_db: Db): Router {
  const router = Router();

  function who(req: Request): QueScope {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    return { scope: companyId, owner: `${actor.actorType}:${actor.actorId}` };
  }

  /** Options for one call; the call stops (and leaves the queue) when the client goes away. */
  function optionsFor(req: Request, res: Response, body: QueBody): QueOptions {
    const scope = who(req);
    if (body.model && !queModelId(body.model)) throw badRequest(`"${body.model}" is not one of the free chat models Que can ask`);
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    return { ...scope, model: body.model, system: body.system, think: body.think, cache: body.cache, fallback: body.fallback, signal: controller.signal };
  }

  function conversationId(req: Request): string {
    const id = req.params.conversationId as string;
    if (!QUE_CONVERSATION_ID_PATTERN.test(id)) throw badRequest("Conversation ids use letters, digits, '.', '_' and '-' (up to 100)");
    return id;
  }

  /**
   * The answer, or undefined once a refusal is sent: a 503, as the request was
   * fine and the models can't answer right now. A client that went away gets
   * nothing. Neither is a server fault, so neither reaches the crash reports.
   */
  async function answering<T>(res: Response, opts: QueOptions, work: () => Promise<T>): Promise<T | undefined> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (!opts.signal?.aborted) res.status(503).json({ error: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }

  router.get("/companies/:companyId/que/stats", (req, res) => {
    res.json(queStats(who(req)));
  });

  router.post("/companies/:companyId/que/chat", validate(queChatSchema), async (req, res) => {
    const body = req.body as QueBody & { prompt?: string; messages?: Array<{ role: "system" | "user" | "assistant"; content: string }> };
    const opts = optionsFor(req, res, body);
    const answer = await answering(res, opts, () => queChat(body.prompt ?? body.messages!, opts));
    if (answer) res.json(answer);
  });

  router.post("/companies/:companyId/que/batch", validate(queBatchSchema), async (req, res) => {
    const body = req.body as QueBody & { prompts: string[] };
    const opts = optionsFor(req, res, body);
    const results = await answering(res, opts, () => queBatch(body.prompts, opts));
    if (results) res.json({ results });
  });

  router.get("/companies/:companyId/que/conversations", (req, res) => {
    res.json(queConversations(who(req)));
  });

  router.delete("/companies/:companyId/que/conversations", (req, res) => {
    res.json({ cleared: queClearConversations(who(req)) });
  });

  router.get("/companies/:companyId/que/conversations/:conversationId", (req, res) => {
    const conversation = queConversation(conversationId(req), who(req));
    if (!conversation) throw notFound("Conversation not found");
    res.json(conversation);
  });

  router.post("/companies/:companyId/que/conversations/:conversationId", validate(queConversationMessageSchema), async (req, res) => {
    const id = conversationId(req);
    const body = req.body as QueBody & { prompt: string };
    const opts = optionsFor(req, res, body);
    const answer = await answering(res, opts, () => queConvo(body.prompt, id, opts));
    if (answer) res.json({ answer, conversation: queConversation(id, opts) });
  });

  router.delete("/companies/:companyId/que/conversations/:conversationId", (req, res) => {
    if (!queClearConversation(conversationId(req), who(req))) throw notFound("Conversation not found");
    res.json({ ok: true });
  });

  return router;
}
