import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { IMY_LANGUAGES, isTerminalToolId, TERMINAL_LANGUAGE_PATTERN, TERMINAL_TOOLS } from "@paperclipai/shared";
import { freeCompleteScript, imyBinary, terminalCommand, terminalTool, withLanguage, withModel } from "./registry.js";
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

  it("passes a chosen language with --to, and only one IMY's menu lists", () => {
    const argv = terminalCommand("imy").run;
    expect(withLanguage(argv, "imy", "rust")).toEqual([...argv, "--to", "rust"]);
    expect(withLanguage(argv, "imy", "cpp")).toEqual([...argv, "--to", "cpp"]);
    expect(withLanguage(argv, "imy", undefined)).toEqual(argv);
    expect(withLanguage(argv, "imy", "")).toEqual(argv);
    // Not on the list, or not a language name at all: the command stays as it was.
    expect(withLanguage(argv, "imy", "klingon")).toEqual(argv);
    expect(withLanguage(argv, "imy", "rust; rm -rf /")).toEqual(argv);
    expect(withLanguage(argv, "imy", "--help")).toEqual(argv);
    // Tools without a language flag ignore the choice.
    expect(withLanguage(["claude"], "claude", "rust")).toEqual(["claude"]);
    expect(withLanguage(["sh"], "shell", "python")).toEqual(["sh"]);
  });

  it("lists languages IMY knows, each once, with names fit for a command line", () => {
    const imy = TERMINAL_TOOLS.find((tool) => tool.id === "imy")!;
    expect(imy.languages).toBe(IMY_LANGUAGES);
    expect(IMY_LANGUAGES[0]).toEqual({ id: "python", name: "Python" });
    const ids = IMY_LANGUAGES.map((language) => language.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(TERMINAL_LANGUAGE_PATTERN);
    for (const wanted of ["javascript", "ruby", "rust", "c", "cpp", "go", "zig", "asm"]) expect(ids).toContain(wanted);
    // Every id is a language name IMY itself resolves (imy-engine/src/imy/languages.py).
    const known = readFileSync(path.join(repoRoot, "imy-engine", "src", "imy", "languages.py"), "utf8");
    for (const id of ids) expect(known).toMatch(new RegExp(`Language\\(\\s*"${id.replace("+", "\\+")}"`));
    for (const tool of TERMINAL_TOOLS) if (tool.id !== "imy") expect(tool.languages).toBeUndefined();
  });

  it("opens IMY with both the model and the language picked", () => {
    const saved = process.platform;
    const opened = __resolveTerminalCommand({
      companyId: "c", toolId: "imy", mode: "run", cols: 80, rows: 24,
      model: "nvidia/nemotron-3.5-lightning:free", language: "javascript",
    });
    expect(process.platform).toBe(saved);
    expect(opened.toolId).toBe("imy");
    const text = opened.argv.join(" ");
    expect(text).toContain("--free-model nvidia/nemotron-3.5-lightning:free");
    expect(text).toContain("--to javascript");
    const plain = __resolveTerminalCommand({ companyId: "c", toolId: "imy", mode: "run", cols: 80, rows: 24, language: "klingon" });
    expect(plain.argv.join(" ")).not.toContain("--to");
    // Installing never takes the language: the installer has no such option.
    const install = __resolveTerminalCommand({ companyId: "c", toolId: "imy", mode: "install", cols: 80, rows: 24, language: "rust" });
    expect(install.argv.join(" ")).not.toContain("--to");
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
