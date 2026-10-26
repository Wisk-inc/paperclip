import { directToolRuntime, type DirectToolRuntime } from "@paperclipai/adapter-claude-local/server";
import type { AdapterExecutionContext } from "../types.js";

/** The file/command/Automa tool runtime for a free agent — same working folder and env as a Claude Code run. */
export function freeDirectToolRuntime(ctx: AdapterExecutionContext): DirectToolRuntime {
  return directToolRuntime(ctx);
}
