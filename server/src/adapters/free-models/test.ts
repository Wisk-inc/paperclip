import { describePuterError, isDroppedConnection, isLastingPuterError, isTransientPuterError, PUTER_DEFAULT_MODEL, PuterHttpError, puterChat } from "@paperclipai/shared/puter-ai";
import type { AdapterEnvironmentCheck, AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "../types.js";
import { modelLabel } from "./execute.js";

/**
 * Asks the default free model for one word. What a person reads when it does
 * not answer is said in plain words, never the service's raw reply: a model
 * at its limit or busy is a warning (the service is reachable; another model
 * answers), and only a service that cannot be reached is a failed connection.
 */
export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const testedAt = new Date().toISOString();
  try {
    await puterChat("Reply with OK.", { model: PUTER_DEFAULT_MODEL, retries: 1 });
    return {
      adapterType: ctx.adapterType,
      status: "pass",
      checks: [{ code: "free_models_reachable", level: "info", message: "The free models answered." }],
      testedAt,
    };
  } catch (error) {
    const check = failedCheck(error);
    return { adapterType: ctx.adapterType, status: check.level === "warn" ? "warn" : "fail", checks: [check], testedAt };
  }
}

function failedCheck(error: unknown): AdapterEnvironmentCheck {
  if (error instanceof PuterHttpError) {
    const message = describePuterError(error, modelLabel(PUTER_DEFAULT_MODEL)).message;
    // The service's own rate limit covers every model: waiting helps, another model does not.
    if (error.slowDown) return { code: "free_models_slow_down", level: "warn", message, hint: "Test again in a minute." };
    // The service answered: it is this one model that cannot reply right now.
    if (isLastingPuterError(error) || isTransientPuterError(error)) {
      return { code: "free_models_default_model_unavailable", level: "warn", message, hint: "The free model service is reachable. Pick another model for this agent, or test again later." };
    }
    return { code: "free_models_refused", level: "error", message, hint: "Test again in a minute." };
  }
  return {
    code: "free_models_unreachable",
    level: "error",
    message: isDroppedConnection(error) ? "Automa could not reach the free model service." : error instanceof Error ? error.message : String(error),
    hint: "Check this device's internet connection, then test again.",
  };
}
