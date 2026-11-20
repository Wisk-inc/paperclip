import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isTerminalToolId, TERMINAL_TOOLS } from "@paperclipai/shared";
import { freeCompleteScript, imyBinary, terminalCommand, terminalTool, withModel } from "./registry.js";
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

describe("IMY terminal", () => {
  const scriptsDir = fileURLToPath(new URL("../scripts/terminals/", import.meta.url));
  const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

  it("opens IMY's console with the free-models bridge in its environment", () => {
    const command = terminalCommand("imy");
    expect(command.run.slice(-2)).toEqual([imyBinary(), "console"]);
    expect(command.run[0]).toBe("env");
    expect(command.run[1]).toBe(`IMY_AUTOMA_BRIDGE='${process.execPath}' '${freeCompleteScript()}'`);
    expect(command.runInLinux).toEqual(["env", `IMY_AUTOMA_BRIDGE=node '${freeCompleteScript()}'`, "imy", "console"]);
    expect(existsSync(freeCompleteScript())).toBe(true);
  });

  it("passes a chosen free model with --free-model and nothing else", () => {
    const argv = terminalCommand("imy").run;
    expect(withModel(argv, "imy", "nvidia/nemotron-3.5-lightning:free")).toEqual([...argv, "--free-model", "nvidia/nemotron-3.5-lightning:free"]);
    expect(withModel(argv, "imy", undefined)).toEqual(argv);
    expect(withModel(argv, "imy", "x; rm -rf /")).toEqual(argv);
  });

  it("finds the IMY the installer linked, else the one on PATH", () => {
    const home = mkdtempSync(path.join(tmpdir(), "imy-home-"));
    try {
      expect(imyBinary(home)).toBe("imy");
      mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
      writeFileSync(path.join(home, ".local", "bin", "imy"), "#!/bin/sh\n");
      expect(imyBinary(home)).toBe(path.join(home, ".local", "bin", "imy"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("lists the free models but not Moan's chat persona", () => {
    const imy = TERMINAL_TOOLS.find((tool) => tool.id === "imy")!;
    expect(imy.linuxOnPhone).toBe(true);
    expect(imy.models?.length).toBeGreaterThan(3);
    expect(imy.models?.some((id) => id.startsWith("moan/"))).toBe(false);
    expect(existsSync(path.join(repoRoot, "ui", "public", imy.brand))).toBe(true);
  });

  it("installs IMY from the wheel shipped with this release", () => {
    const setup = readFileSync(path.join(scriptsDir, "linux-setup.sh"), "utf8");
    expect(setup).toMatch(/\n\s+imy\)\n\s+install_imy\n/);
    const version = /__version__ = "([^"]+)"/.exec(readFileSync(path.join(repoRoot, "imy-engine", "src", "imy", "__init__.py"), "utf8"))![1];
    const wheels = readdirSync(path.join(scriptsDir, "imy")).filter((name) => name.endsWith(".whl"));
    expect(wheels).toEqual([`imagenery-${version}-py3-none-any.whl`]);
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
