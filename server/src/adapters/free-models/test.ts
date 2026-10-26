import { puterChat } from "@paperclipai/shared/puter-ai";
import type { AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "../types.js";

export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const testedAt = new Date().toISOString();
  try {
    await puterChat("Reply with OK.", { retries: 1 });
    return {
      adapterType: ctx.adapterType,
      status: "pass",
      checks: [{ code: "free_models_reachable", level: "info", message: "The free models answered." }],
      testedAt,
    };
  } catch (error) {
    return {
      adapterType: ctx.adapterType,
      status: "fail",
      checks: [{
        code: "free_models_unreachable",
        level: "error",
        message: error instanceof Error ? error.message : String(error),
        hint: "Check this device's internet connection, then test again.",
      }],
      testedAt,
    };
  }
}
