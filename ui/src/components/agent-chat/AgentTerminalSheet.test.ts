import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "@/adapters";
import { processCommand, terminalLines } from "./AgentTerminalSheet";

const ts = "2026-09-29T00:00:00.000Z";

describe("agent terminal", () => {
  it("shows each shell command an agent ran and what it printed", () => {
    const entries: TranscriptEntry[] = [
      { kind: "assistant", ts, text: "Checking the files" },
      { kind: "tool_call", ts, name: "Bash", input: { command: "ls -la" }, toolUseId: "t1" },
      { kind: "tool_result", ts, toolUseId: "t1", content: "total 0\nREADME.md", isError: false },
      { kind: "tool_call", ts, name: "Read", input: { path: "README.md" }, toolUseId: "t2" },
      { kind: "tool_result", ts, toolUseId: "t2", content: "# hello", isError: false },
      { kind: "stdout", ts, text: "noise that is not a command" },
      { kind: "run_terminal", ts, turnState: "completed", runState: "succeeded", disposition: "done" },
    ];
    expect(terminalLines(entries).map((line) => [line.kind, line.text])).toEqual([
      ["command", "ls -la"],
      ["output", "total 0\nREADME.md"],
      ["note", "run succeeded"],
    ]);
  });

  it("treats a run without tool calls as a plain process and shows its output", () => {
    const entries: TranscriptEntry[] = [
      { kind: "stdout", ts, text: "[paperclip] Using fallback workspace" },
      { kind: "stdout", ts, text: "hello from the phone terminal\nLinux" },
      { kind: "stderr", ts, text: "warning: low battery" },
    ];
    expect(terminalLines(entries, "sh -c \"echo hi\"").map((line) => [line.kind, line.text])).toEqual([
      ["command", "sh -c \"echo hi\""],
      ["note", "[paperclip] Using fallback workspace"],
      ["output", "hello from the phone terminal\nLinux"],
      ["error", "warning: low battery"],
    ]);
  });

  it("reads a process agent's command from its settings", () => {
    expect(processCommand({ command: "sh", args: ["-c", "echo hello; uname -s"] })).toBe("sh -c \"echo hello; uname -s\"");
    expect(processCommand({ command: "node", args: ["run.js"] })).toBe("node run.js");
    expect(processCommand({})).toBeNull();
  });
});
