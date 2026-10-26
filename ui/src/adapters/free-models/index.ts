import { FREE_MODELS_ADAPTER_TYPE } from "@paperclipai/shared";
import type { TranscriptEntry, UIAdapterModule } from "../types";

/** Reasoning arrives as one JSON line per reply; everything else is a plain status line. */
export function parseFreeModelsStdoutLine(line: string, ts: string): TranscriptEntry[] {
  if (line.startsWith('{"type":"thinking"')) {
    try {
      const parsed = JSON.parse(line) as { text?: unknown };
      if (typeof parsed.text === "string" && parsed.text.trim()) return [{ kind: "thinking", ts, text: parsed.text }];
    } catch {
      // Not a reasoning line after all; show it as written.
    }
  }
  return [{ kind: "stdout", ts, text: line }];
}

export const freeModelsUIAdapter: UIAdapterModule = {
  type: FREE_MODELS_ADAPTER_TYPE,
  label: "Free models",
  parseStdoutLine: parseFreeModelsStdoutLine,
  ConfigFields: () => null,
  buildAdapterConfig: (values) => (values.model ? { model: values.model } : {}),
};
