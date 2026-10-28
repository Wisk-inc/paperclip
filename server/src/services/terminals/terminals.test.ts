import { describe, expect, it } from "vitest";
import { isTerminalToolId, TERMINAL_TOOLS } from "@paperclipai/shared";
import { terminalCommand, terminalTool } from "./registry.js";
import { linuxRunArgv, setupScriptArgv, LINUX_DISTRO } from "./linux-layer.js";
import { __resolveTerminalCommand, terminalRelayEnv } from "./sessions.js";

describe("terminal registry", () => {
  it("is a closed set of known tools", () => {
    expect(isTerminalToolId("claude")).toBe(true);
    expect(isTerminalToolId("rm -rf /")).toBe(false);
    expect(isTerminalToolId("")).toBe(false);
    for (const tool of TERMINAL_TOOLS) {
      expect(terminalTool(tool.id)).not.toBeNull();
      expect(terminalCommand(tool.id)).toBeTruthy();
    }
  });
});

describe("linux layer argv", () => {
  it("runs a tool inside proot Debian, binding the files tree and entering the cwd", () => {
    const argv = linuxRunArgv(["claude"], "/data/data/com.termux/files/home/project");
    expect(argv.slice(0, 3)).toEqual(["proot-distro", "login", LINUX_DISTRO]);
    expect(argv).toContain("--bind");
    const inner = argv.at(-1)!;
    expect(inner).toContain("cd '/data/data/com.termux/files/home/project'");
    expect(inner).toContain("exec 'claude'");
  });

  it("quotes the command safely", () => {
    const inner = linuxRunArgv(["sh", "-c", "echo 'hi'"]).at(-1)!;
    expect(inner).toContain("exec 'sh' '-c' 'echo '\\''hi'\\'''");
  });

  it("builds a fixed setup/install argv, never a caller command", () => {
    expect(setupScriptArgv("setup")).toEqual(["bash", expect.stringContaining("linux-setup.sh"), "setup"]);
    expect(setupScriptArgv("install", "codex")).toEqual(["bash", expect.stringContaining("linux-setup.sh"), "install", "codex"]);
  });
});

describe("command resolution", () => {
  it("runs the login shell for the shell tool, and the setup script for setup mode", () => {
    const shell = __resolveTerminalCommand({ companyId: "c", toolId: "shell", mode: "shell", cols: 80, rows: 24 });
    expect(shell.toolId).toBe("shell");
    expect(shell.argv.length).toBeGreaterThanOrEqual(1);
    const setup = __resolveTerminalCommand({ companyId: "c", toolId: "claude", mode: "setup", cols: 80, rows: 24 });
    expect(setup.toolId).toBe("setup");
    expect(setup.argv[0]).toBe("bash");
  });
});

describe("terminal environment", () => {
  it("keeps Automa's app key, database password and sign-in secret out of the relay", () => {
    const saved = { ...process.env };
    process.env.PAPERCLIP_LOCAL_TRUSTED_SECRET = "app-key";
    process.env.DATABASE_URL = "postgres://u:pw@127.0.0.1:5432/automa";
    process.env.BETTER_AUTH_SECRET = "auth";
    try {
      const env = terminalRelayEnv({ GH_TOKEN: "mine" });
      expect(env.PAPERCLIP_LOCAL_TRUSTED_SECRET).toBeUndefined();
      expect(env.DATABASE_URL).toBeUndefined();
      expect(env.BETTER_AUTH_SECRET).toBeUndefined();
      expect(env.GH_TOKEN).toBe("mine");
      expect(env.TERM).toBe("xterm-256color");
    } finally {
      process.env = saved;
    }
  });
});
