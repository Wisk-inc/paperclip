#!/usr/bin/env node
// A chat with the free models in a terminal: no key, streamed replies, the
// model's thinking dimmed. Opened from the Terminals page ("Free models").
//
//   free-chat.mjs [--model <id>]      /model <id> switches, /clear starts over, /quit leaves
import { createInterface } from "node:readline";
// The built package on a phone or a release; the workspace's built output in a
// source checkout, where the package's export map points at TypeScript.
const puter = await import("@paperclipai/shared/puter-ai").catch(() =>
  import(import.meta.resolve("@paperclipai/shared/puter-ai").replace(/\/src\/(.*)\.ts$/, "/dist/$1.js")),
);
const { puterStream, PuterHttpError, PUTER_MODELS, PUTER_MODEL_META } = puter;
const moan = await import("@paperclipai/shared/moan").catch(() =>
  import(import.meta.resolve("@paperclipai/shared/moan").replace(/\/src\/(.*)\.ts$/, "/dist/$1.js")),
);
const { MOAN_MODEL_ID, MOAN_LABEL, isMoanModel, resolveFreeModel, moanSystemPrompt } = moan;

const args = process.argv.slice(2);
let model = args[args.indexOf("--model") + 1] && args.includes("--model") ? args[args.indexOf("--model") + 1] : PUTER_MODELS["deepseek-flash"];
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const label = (id) => { if (isMoanModel(id)) return MOAN_LABEL; const key = Object.keys(PUTER_MODELS).find((k) => PUTER_MODELS[k] === id); return key ? PUTER_MODEL_META[key].label : id; };
const allModels = [MOAN_MODEL_ID, ...Object.values(PUTER_MODELS)];
// Moan talks Patois and carries its Jamaica primer; the others get a plain terminal prompt.
const systemFor = (id) => (isMoanModel(id) ? moanSystemPrompt({}) : "You are a helpful assistant in a terminal. Answer plainly; use Markdown lightly.");
const messages = [{ role: "system", content: systemFor(model) }];

console.log(bold(`Free models · ${label(model)}`));
console.log(dim(`Type a message. /model <id> to switch (${allModels.slice(0, 4).join(", ")}, …), /clear to start over, /quit to leave.`));
const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "\n> " });
rl.prompt();
let busy = false;
rl.on("line", async (line) => {
  const text = line.trim();
  if (!text || busy) { rl.prompt(); return; }
  if (text === "/quit" || text === "/exit") { rl.close(); return; }
  if (text === "/clear") { messages.length = 1; console.log(dim("Started over.")); rl.prompt(); return; }
  if (text.startsWith("/model")) {
    const next = text.slice(6).trim();
    if (next) { model = next; messages[0] = { role: "system", content: systemFor(model) }; console.log(dim(`Now ${label(model)}`)); } else console.log(allModels.map((id) => `  ${id}`).join("\n"));
    rl.prompt(); return;
  }
  busy = true;
  messages.push({ role: "user", content: text });
  let reply = "";
  let thinking = false;
  try {
    process.stdout.write("\n");
    for await (const event of puterStream(messages, { model: resolveFreeModel(model).puterModel })) {
      if (event.type === "reasoning") { if (!thinking) { thinking = true; process.stdout.write(dim("thinking: ")); } process.stdout.write(dim(event.text)); }
      else if (event.type === "text") { if (thinking) { thinking = false; process.stdout.write("\n\n"); } reply += event.text; process.stdout.write(event.text); }
    }
    process.stdout.write("\n");
    messages.push({ role: "assistant", content: reply || "(no reply)" });
  } catch (error) {
    messages.pop();
    const why = error instanceof PuterHttpError ? `${error.status}${error.upstream ? ` ${error.upstream}` : ""}` : String(error?.message ?? error);
    console.log(`\n${label(model)} could not answer: ${why}. Try again, or /model another.`);
  } finally {
    busy = false;
    if (closing) { console.log(dim("\nBye.")); process.exit(0); }
    rl.prompt();
  }
});
// Ctrl+D mid-reply: let the reply finish, then leave.
let closing = false;
rl.on("close", () => { if (busy) { closing = true; return; } console.log(dim("\nBye.")); process.exit(0); });
