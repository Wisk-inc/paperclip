import { z } from "zod";

/** Every free-model call waits its turn in the Que engine: this many run at once, the rest wait in order. */
export const QUE_MAX_IN_FLIGHT = 10;
/** On any one model, only this many at once: the service refuses a bigger burst to a single model. */
export const QUE_PER_MODEL_IN_FLIGHT = 2;
export const QUE_MAX_BATCH = 20;

/** How much a Que call is asked to think before it answers. */
export const QUE_THINK_MODES = ["quick", "normal", "deep", "max"] as const;
export type QueThinkMode = (typeof QUE_THINK_MODES)[number];

export interface QueMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface QueUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface QueAnswer {
  text: string;
  reasoning: string;
  /** The model that answered: the one asked for, or the free model it handed the question to. */
  model: string;
  requestedModel: string;
  usage: QueUsage;
  /** Answered from the 5-minute cache, without a request. */
  cached: boolean;
  /** Tries for this answer, counting retries and models handed over to (0 from the cache). */
  attempts: number;
}

export type QueBatchItem = QueAnswer | { error: string };

export interface QueConversation {
  id: string;
  model: string;
  messages: QueMessage[];
  updatedAt: string;
}

export interface QueStats {
  maxInFlight: number;
  inFlight: number;
  waiting: number;
  /** Free-model requests sent since the server started. */
  started: number;
  peakInFlight: number;
  appIdPool: { total: number; cooling: number; active: number };
  /** This company's cached answers, and how often they were reused. */
  cachedAnswers: number;
  cacheHits: number;
  conversations: number;
}

const queText = z.string().trim().min(1).max(20_000);

const queOptions = {
  model: z.string().trim().min(1).max(200).optional(),
  /** Instructions for the model; in a conversation, they replace the ones it has. */
  system: z.string().trim().max(20_000).optional(),
  think: z.enum(QUE_THINK_MODES).optional(),
  /** Reuse an answer to the same question from the last 5 minutes (default true). */
  cache: z.boolean().optional(),
  /** When the model can't answer today, hand the question to the next free model (default true). */
  fallback: z.boolean().optional(),
};

export const queChatSchema = z
  .object({
    ...queOptions,
    prompt: queText.optional(),
    messages: z
      .array(z.object({ role: z.enum(["system", "user", "assistant"]), content: queText }))
      .min(1)
      .max(100)
      .optional(),
  })
  .refine((value) => Boolean(value.prompt) !== Boolean(value.messages), {
    message: "Send a prompt or messages, not both",
    path: ["prompt"],
  });

export const queBatchSchema = z.object({
  ...queOptions,
  prompts: z.array(queText).min(1).max(QUE_MAX_BATCH),
});

export const queConversationMessageSchema = z.object({
  ...queOptions,
  prompt: queText,
});

export const QUE_CONVERSATION_ID_PATTERN = /^[\w.-]{1,100}$/;
