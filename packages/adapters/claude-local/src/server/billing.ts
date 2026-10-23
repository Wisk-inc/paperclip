import type { AdapterBillingType } from "@paperclipai/adapter-utils";

/**
 * Who bills a Claude run, read from the env Claude Code will see. Only a
 * Claude subscription sign-in is included in a plan; Bedrock, Vertex, Foundry,
 * an API key and a bearer-token gateway all charge per token, and counting
 * them as "subscription" recorded every run at $0, so budgets never stopped
 * them.
 */
export function resolveClaudeBillingIdentity(
  read: (key: string) => string,
): { biller: string; billingType: AdapterBillingType } {
  const flag = (key: string) => {
    const value = read(key).trim().toLowerCase();
    return value === "1" || value === "true";
  };
  if (flag("CLAUDE_CODE_USE_BEDROCK") || read("ANTHROPIC_BEDROCK_BASE_URL").trim()) {
    return { biller: "aws_bedrock", billingType: "metered_api" };
  }
  if (flag("CLAUDE_CODE_USE_VERTEX")) return { biller: "google_vertex", billingType: "metered_api" };
  if (flag("CLAUDE_CODE_USE_FOUNDRY")) return { biller: "microsoft_foundry", billingType: "metered_api" };
  if (read("ANTHROPIC_API_KEY").trim()) return { biller: "anthropic", billingType: "api" };
  if (read("ANTHROPIC_AUTH_TOKEN").trim()) {
    return read("ANTHROPIC_BASE_URL").trim()
      ? { biller: "llm_gateway", billingType: "metered_api" }
      : { biller: "anthropic", billingType: "api" };
  }
  return { biller: "anthropic", billingType: "subscription" };
}
