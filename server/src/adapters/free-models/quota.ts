import type { ProviderQuotaResult, QuotaWindow } from "@paperclipai/adapter-utils";
import { freeModelAllowance, freeModelHealth, type PuterModelId } from "@paperclipai/shared/puter-ai";
import { modelLabel } from "./execute.js";

/** Free models listed beside the allowance: the ones that hit a limit, then the busiest. */
const MAX_MODEL_WINDOWS = 8;

const count = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** The service's allowance renews with the calendar month (UTC). */
function nextMonthStart(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

function requestsLabel(requests: number): string {
  return `${count.format(requests)} ${requests === 1 ? "request" : "requests"} this month`;
}

/**
 * The free models' limits for the Costs page: the month's allowance the
 * service shares between everyone on Automa's free models, and each model
 * that reached its daily limit (with when it answers again) or is in use.
 */
export async function getFreeModelQuotaWindows(): Promise<ProviderQuotaResult> {
  let allowance;
  try {
    allowance = await freeModelAllowance();
  } catch (error) {
    return {
      provider: "free_models",
      ok: false,
      error: `Couldn't read the free models' usage: ${error instanceof Error ? error.message : String(error)}`,
      windows: [],
    };
  }

  const used = Math.max(0, allowance.allowance - allowance.remaining);
  const windows: QuotaWindow[] = [
    {
      label: "Monthly allowance",
      usedPercent: allowance.allowance > 0 ? Math.min(100, (used / allowance.allowance) * 100) : null,
      resetsAt: nextMonthStart(),
      valueLabel: `${count.format(allowance.remaining)} of ${count.format(allowance.allowance)} ${allowance.unit} left`,
      detail: "Shared by everyone on Automa's free models. The free models use none of it; paid extras such as data transfer do.",
    },
  ];

  const health = freeModelHealth();
  const now = Date.now();
  const models = new Set<string>([...Object.keys(allowance.requestsByModel), ...Object.keys(health)]);
  const rows = [...models].map((model) => {
    const entry = health[model];
    const limited = entry?.state === "daily_limit" && entry.until && Date.parse(entry.until) > now ? entry.until : null;
    const busy = entry?.state === "busy" && entry.until && Date.parse(entry.until) > now;
    const requests = allowance.requestsByModel[model as PuterModelId] ?? 0;
    return { model, limited, busy, requests };
  }).filter((row) => row.limited || row.requests > 0);
  rows.sort((a, b) => Number(Boolean(b.limited)) - Number(Boolean(a.limited)) || b.requests - a.requests);

  for (const row of rows.slice(0, MAX_MODEL_WINDOWS)) {
    windows.push(row.limited
      ? {
          label: modelLabel(row.model),
          usedPercent: 100,
          resetsAt: row.limited,
          valueLabel: "Daily limit reached",
          detail: requestsLabel(row.requests),
        }
      : {
          label: modelLabel(row.model),
          usedPercent: null,
          resetsAt: null,
          valueLabel: row.busy ? "Busy right now" : "Available",
          detail: requestsLabel(row.requests),
        });
  }

  return { provider: "free_models", source: "Automa free models", ok: true, windows };
}
