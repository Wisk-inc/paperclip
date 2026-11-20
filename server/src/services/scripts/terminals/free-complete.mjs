#!/usr/bin/env node
// IMY's bridge to the free models: one JSON request on stdin, one JSON reply on
// stdout. Automa's IMY terminal hands its path to IMY (IMY_AUTOMA_BRIDGE), so
// `imy run` and `imy console` can compile with the free models while the
// service token stays inside Automa's own code and is never printed.
//
//   stdin  {"op":"complete","model":"<id>","system":"...","messages":[{"role":"user","content":"..."}]}
//          {"op":"models"}
//   stdout {"ok":true,"text":"...","model":"<id>","usage":{"inputTokens":0,"outputTokens":0},"stopReason":"..."}
//          {"ok":true,"models":[{"id":"<id>","label":"..."}]}
//          {"ok":false,"error":{"kind":"busy|daily_limit|restricted|withdrawn|charged|rejected|timeout|network|bad_request|error","message":"..."}}
// The built package on a phone or a release; the workspace's built output in a
// source checkout, where the package's export map points at TypeScript.
const puter = await import("@paperclipai/shared/puter-ai").catch(() =>
  import(import.meta.resolve("@paperclipai/shared/puter-ai").replace(/\/src\/(.*)\.ts$/, "/dist/$1.js")),
);
const { puterStream, PuterHttpError, PUTER_MODELS, PUTER_MODEL_META, PUTER_DEFAULT_MODEL } = puter;
const moan = await import("@paperclipai/shared/moan").catch(() =>
  import(import.meta.resolve("@paperclipai/shared/moan").replace(/\/src\/(.*)\.ts$/, "/dist/$1.js")),
);
const { resolveFreeModel } = moan;

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
// A content-safety classifier, not a model that writes code.
const NOT_FOR_CODE = new Set(["nemotron-safety"]);

const answer = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const fail = (kind, message) => answer({ ok: false, error: { kind, message: String(message).slice(0, 400) } });

const labelOf = (id) => {
  const key = Object.keys(PUTER_MODELS).find((k) => PUTER_MODELS[k] === id);
  return key ? PUTER_MODEL_META[key].label : id;
};

async function readRequest() {
  let size = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("the request is larger than 4 MB");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function models() {
  const ids = [PUTER_DEFAULT_MODEL, ...Object.entries(PUTER_MODELS).filter(([key]) => !NOT_FOR_CODE.has(key)).map(([, id]) => id)];
  return [...new Set(ids)].map((id) => ({ id, label: labelOf(id) }));
}

function messagesFrom(request) {
  if (typeof request.system !== "string") throw new Error("system must be text");
  if (!Array.isArray(request.messages) || request.messages.length === 0) throw new Error("messages must be a non-empty list");
  const turns = request.messages.map((message) => {
    if (!message || (message.role !== "user" && message.role !== "assistant") || typeof message.content !== "string") {
      throw new Error("each message needs a role (user or assistant) and text content");
    }
    return { role: message.role, content: message.content };
  });
  return [{ role: "system", content: request.system }, ...turns];
}

function errorKind(error) {
  const code = error?.cause?.code ?? error?.code;
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "timeout";
  if (["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].includes(code)) return "network";
  if (/fetch failed|network/i.test(String(error?.message ?? ""))) return "network";
  return "error";
}

let request;
try {
  request = await readRequest();
} catch (error) {
  fail("bad_request", `IMY sent a request the bridge can't read: ${error?.message ?? error}`);
  process.exit(0);
}

if (request?.op === "models") {
  answer({ ok: true, models: models() });
  process.exit(0);
}
if (request?.op !== "complete") {
  fail("bad_request", `unknown op ${JSON.stringify(request?.op)}`);
  process.exit(0);
}

const model = typeof request.model === "string" && request.model ? request.model : PUTER_DEFAULT_MODEL;
let messages;
try {
  messages = messagesFrom(request);
} catch (error) {
  fail("bad_request", error.message);
  process.exit(0);
}

let text = "";
let usage = { inputTokens: 0, outputTokens: 0 };
let stopReason = null;
try {
  for await (const event of puterStream(messages, { model: resolveFreeModel(model).puterModel })) {
    if (event.type === "text") text += event.text;
    else if (event.type === "done") {
      usage = event.usage ?? usage;
      stopReason = event.stopReason ?? null;
    }
  }
  answer({ ok: true, text, model, usage, stopReason });
} catch (error) {
  if (error instanceof PuterHttpError) {
    const why = error.upstream ? `: ${error.upstream}` : "";
    fail(error.kind, `${labelOf(model)} could not answer (${error.status}${why}). Try again, or pick another free model.`);
  } else {
    fail(errorKind(error), `${labelOf(model)} could not answer: ${error?.message ?? error}`);
  }
}
process.exit(0);
