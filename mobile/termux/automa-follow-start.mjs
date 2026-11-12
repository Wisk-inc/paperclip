// Follows a starting Automa until it is ready, printing each step it reports
// (Automa 1.9.10 on: its health answer carries `startup`). The `automa`
// launcher runs it for `automa run` while Automa already runs in the
// background, and for `automa status` (--once).
//
// Exits 0 once Automa is ready, 1 when nothing answers (for a minute, or at
// once with --once), 2 with --once while it is still starting.
//
// AUTOMA_HEALTH_URL, AUTOMA_FOLLOW_POLL_MS and AUTOMA_FOLLOW_SILENT_MS exist
// for tests.
const once = process.argv.includes("--once");
const url = process.env.AUTOMA_HEALTH_URL || "http://127.0.0.1:3100/api/health";
const pollMs = Number(process.env.AUTOMA_FOLLOW_POLL_MS) || 1500;
const silentLimitMs = Number(process.env.AUTOMA_FOLLOW_SILENT_MS) || 60_000;

let last = "";
let silentSince = 0;

function say(line) {
  if (line === last) return;
  last = line;
  console.log(line);
}

function describe(body) {
  const startup = body && typeof body.startup === "object" ? body.startup : null;
  const step = startup && typeof startup.step === "object" ? startup.step : null;
  if (!step || typeof step.label !== "string") return "Automa is starting up…";
  const place = Number.isInteger(step.number) && Number.isInteger(step.total) ? ` (step ${step.number} of ${step.total})` : "";
  return `Automa is starting up: ${step.label}${place}…`;
}

async function check() {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    const body = await res.json().catch(() => null);
    silentSince = 0;
    if (res.ok && body && body.status === "ok") {
      say("Automa is running and ready on http://127.0.0.1:3100");
      process.exit(0);
    }
    if (res.ok) say(describe(body));
    else say(`Automa is starting up (${(body && (body.error || body.status)) || `HTTP ${res.status}`})…`);
    if (once) process.exit(2);
  } catch {
    if (once) {
      say("Automa is not answering. Start it with: automa run");
      process.exit(1);
    }
    if (!silentSince) silentSince = Date.now();
    if (Date.now() - silentSince >= silentLimitMs) {
      console.error("Automa stopped answering. Start it again with: automa run");
      process.exit(1);
    }
    say("Waiting for Automa to answer…");
  }
  setTimeout(check, pollMs);
}

check();
