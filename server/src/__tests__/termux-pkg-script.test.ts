import { execFile, spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openQuickTunnel } from "../services/studio/tunnel.js";

const SCRIPTS = fileURLToPath(new URL("../services/scripts/", import.meta.url));
const MOBILE_TERMUX = fileURLToPath(new URL("../../../mobile/termux/", import.meta.url));

/**
 * A fake Termux: `pkg` ends the way it does when Android clears apt's cache
 * mid-download, and `apt-get` only installs into a download folder whose
 * partial/ exists, like the real one.
 */
let root = "";
let prefix = "";
let bin = "";
async function fake(name: string, body: string, dir = bin) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), `#!/usr/bin/env bash\n${body}\n`);
  await chmod(path.join(dir, name), 0o755);
}
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "termux-pkg-"));
  prefix = path.join(root, "com.termux", "files", "usr");
  bin = path.join(root, "fakebin");
  await mkdir(bin, { recursive: true });
  await mkdir(path.join(prefix, "bin"), { recursive: true });
  await fake("pkg", `echo "pkg $*" >> "${root}/calls.log"; [ -f "${root}/pkg-works" ] && exit 0; echo "E: rename failed, No such file or directory" >&2; exit 100`);
  await fake("apt-config", `echo "dir='${root}/com.termux/cache/apt/archives/'"`);
  await fake("apt-get", [
    `echo "apt-get $*" >> "${root}/calls.log"`,
    `[ "$*" = "update" ] && exit 0`,
    `[ -f "${root}/apt-fails" ] && exit 100`,
    `for arg in "$@"; do case "$arg" in Dir::Cache::archives=*) dir="\${arg#Dir::Cache::archives=}";; esac; done`,
    `[ -n "\${dir:-}" ] && [ -d "\${dir}partial" ] || exit 100`,
    `pkgname="\${@: -1}"`,
    `printf '#!/usr/bin/env bash\\necho "%s ran: $*"\\n' "$pkgname" > "${prefix}/bin/$pkgname"; chmod 755 "${prefix}/bin/$pkgname"`,
  ].join("\n"));
});
afterEach(async () => {
  vi.useRealTimers();
  delete process.env.PAPERCLIP_CLOUDFLARED_PATH;
  await rm(root, { recursive: true, force: true });
});

/** Every path the scripts write to points into the fake phone, never at this machine's own. */
function phoneEnv(extra: Record<string, string> = {}) {
  return {
    ...process.env,
    PREFIX: prefix,
    HOME: path.join(root, "home"),
    PATH: `${bin}:${prefix}/bin:/usr/bin:/bin`,
    AUTOMA_PKG_RETRY_WAIT: "0",
    AUTOMA_HOME: path.join(root, "home", ".automa"),
    AUTOMA_PGDATA: path.join(root, "pgdata"),
    PAPERCLIP_HOME: path.join(root, "paperclip"),
    PAPERCLIP_INSTANCE_ID: "default",
    TMPDIR: path.join(root, "tmp"),
    // How much room the installer asks for: none, so no test depends on how full this machine's own disk is.
    AUTOMA_INSTALL_NEED_MB: "0",
    AUTOMA_UPDATE_HEADROOM_MB: "0",
    ...extra,
  };
}

function runFile(file: string, args: string[], options: { command?: string[]; env?: Record<string, string> } = {}) {
  const [command, ...pre] = options.command ?? ["bash"];
  return new Promise<{ code: number; out: string }>((resolve) => {
    execFile(command!, [...pre, file, ...args], { env: phoneEnv(options.env), cwd: root, timeout: 30_000 }, (error, stdout, stderr) =>
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}` }),
    );
  });
}

function run(script: string, args: string[]) {
  return runFile(path.join(SCRIPTS, script), args);
}

describe("termux-pkg.sh", () => {
  it("makes apt's real download folder before installing", async () => {
    await writeFile(path.join(root, "pkg-works"), "");
    const result = await run("termux-pkg.sh", ["apktool"]);
    expect(result.code).toBe(0);
    // Beside files/, where Termux keeps it, not inside it.
    expect((await stat(path.join(root, "com.termux", "cache", "apt", "archives", "partial"))).isDirectory()).toBe(true);
    expect(await readFile(path.join(root, "calls.log"), "utf8")).toBe("pkg install -y apktool\n");
  });

  it("installs again with its own download folder when the cache vanished mid-download", async () => {
    const result = await run("termux-pkg.sh", ["apktool"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("trying again with Automa's own download folder");
    const calls = await readFile(path.join(root, "calls.log"), "utf8");
    expect(calls).toContain(`apt-get -o Dir::Cache::archives=${prefix}/var/cache/automa-apt/archives/ -o Acquire::Retries=3 install -y --fix-missing apktool`);
    // The private folder is cleared afterwards so the phone keeps its space.
    await expect(stat(path.join(prefix, "var", "cache", "automa-apt"))).rejects.toThrow();
  });

  it("fails cleanly when nothing installs", async () => {
    await writeFile(path.join(root, "apt-fails"), "");
    const result = await run("termux-pkg.sh", ["apktool"]);
    expect(result.code).not.toBe(0);
  });
});

describe("app-inspector.sh decode on a phone", () => {
  /** GitHub as apktool's jar fallback sees it: the API, the release page's redirect, and the download. */
  async function fakeGithub() {
    await fake("curl", [
      `echo "curl $*" >> "${root}/calls.log"`,
      `case "$*" in`,
      `  *api.github.com*) [ -f "${root}/api-limited" ] && exit 22; echo '{"assets":[{"name":"apktool_3.0.3.jar","browser_download_url": "https://github.com/iBotPeaches/Apktool/releases/download/v3.0.3/apktool_3.0.3.jar"}]}';;`,
      `  *url_effective*) printf '%s' "https://github.com/iBotPeaches/Apktool/releases/tag/v3.0.4";;`,
      `  *) out=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done`,
      `     if [ -f "${root}/error-page" ]; then echo "<html>Rate limited</html>" > "$out"; else printf 'PK\\003\\004jar' > "$out"; fi;;`,
      "esac",
    ].join("\n"));
  }

  it("gets apktool through the helper and decodes", async () => {
    await writeFile(path.join(root, "app.apk"), "apk");
    await writeFile(path.join(bin, "java"), "#!/usr/bin/env bash\necho java\n");
    await chmod(path.join(bin, "java"), 0o755);
    const result = await run("app-inspector/app-inspector.sh", ["decode", path.join(root, "app.apk"), path.join(root, "out")]);
    expect(result.out).toContain("Installing apktool (first time only)");
    expect(result.out).toContain("apktool ran: d -f");
    expect(result.code).toBe(0);
  });

  it("falls back to apktool's release jar when the package won't install", async () => {
    await writeFile(path.join(root, "apt-fails"), "");
    await writeFile(path.join(root, "app.apk"), "apk");
    await fake("java", `echo "java $*"`);
    await fakeGithub();
    const result = await run("app-inspector/app-inspector.sh", ["decode", path.join(root, "app.apk"), path.join(root, "out")]);
    expect(result.out).toContain("Downloading apktool from its GitHub release instead");
    expect(result.out).toContain(`java -jar ${path.join(root, "home", ".automa", "tools", "apktool.jar")} d -f`);
    expect(result.code).toBe(0);
  });

  it("finds the jar from the release page when GitHub's API limit is used up", async () => {
    await writeFile(path.join(root, "apt-fails"), "");
    await writeFile(path.join(root, "api-limited"), "");
    await writeFile(path.join(root, "app.apk"), "apk");
    await fake("java", `echo "java $*"`);
    await fakeGithub();
    const result = await run("app-inspector/app-inspector.sh", ["decode", path.join(root, "app.apk"), path.join(root, "out")]);
    expect(result.code).toBe(0);
    expect(await readFile(path.join(root, "calls.log"), "utf8")).toContain("https://github.com/iBotPeaches/Apktool/releases/download/v3.0.4/apktool_3.0.4.jar");
    expect(result.out).toContain(`java -jar ${path.join(root, "home", ".automa", "tools", "apktool.jar")} d -f`);
  });

  it("never keeps a download that is not a jar", async () => {
    await writeFile(path.join(root, "apt-fails"), "");
    await writeFile(path.join(root, "error-page"), "");
    await writeFile(path.join(root, "app.apk"), "apk");
    await fake("java", `echo "java $*"`);
    await fakeGithub();
    const result = await run("app-inspector/app-inspector.sh", ["decode", path.join(root, "app.apk"), path.join(root, "out")]);
    expect(result.code).toBe(3);
    expect(await readdir(path.join(root, "home", ".automa", "tools"))).toEqual([]);
  });

  it("signs with jarsigner when apksigner can't be installed", async () => {
    await writeFile(path.join(root, "apt-fails"), "");
    const decoded = path.join(root, "project", "decoded");
    await mkdir(decoded, { recursive: true });
    await fake("java", `echo "java $*"`);
    await fake("apktool", `echo "apktool $*"; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && echo apk > "$2"; shift; done`);
    await fake("keytool", `while [ $# -gt 0 ]; do [ "$1" = "-keystore" ] && echo ks > "$2"; shift; done`);
    await fake("jarsigner", `echo "jarsigner $*" >> "${root}/calls.log"`);
    const result = await run("app-inspector/app-inspector.sh", ["rebuild", decoded, "app-automa.apk"]);
    expect(result.out).toContain("signing with jarsigner");
    expect(result.out).toContain(`[OUTPUT] ${path.join(root, "project", "out", "app-automa.apk")}`);
    expect(result.code).toBe(0);
  });
});

describe("linux-setup.sh on a phone", () => {
  it("installs Claude Code from npm when the installer download fails", async () => {
    // The Debian layer: proot-distro runs the command here, with Debian's tools
    // in ~/.local/bin (first on the PATH the script sets there).
    const debian = path.join(root, "home", ".local", "bin");
    await fake("proot-distro", [
      `echo "proot-distro $*" >> "${root}/calls.log"`,
      `case "$1" in`,
      `  list) [ "\${2:-}" = "--installed" ] && echo "debian"; exit 0;;`,
      `  login) shift 3; [ "$1" = bash ] && [ "$2" = -lc ] && exec bash -c "$3"; exec "$@";;`,
      `esac`,
    ].join("\n"));
    await fake("apt-get", "exit 0", debian);
    await fake("node", "echo true", debian);
    await fake("curl", `echo "curl $*" >> "${root}/calls.log"; echo "curl: (6) Could not resolve host" >&2; exit 6`, debian);
    await fake("npm", `echo "npm $*" >> "${root}/calls.log"; printf '#!/usr/bin/env bash\\necho "2.0.0 (Claude Code)"\\n' > "${debian}/claude"; chmod 755 "${debian}/claude"`, debian);
    const result = await run("terminals/linux-setup.sh", ["install", "claude"]);
    const calls = await readFile(path.join(root, "calls.log"), "utf8");
    expect(calls).toContain("curl -fsSL https://claude.ai/install.sh");
    expect(calls).toContain("npm install -g @anthropic-ai/claude-code");
    expect(result.out).toContain("2.0.0 (Claude Code)");
    expect(result.code).toBe(0);
  });
});

describe("linux-setup.sh installing IMY", () => {
  const home = () => path.join(root, "home");
  const debian = () => path.join(home(), ".local", "bin");
  const calls = () => readFile(path.join(root, "calls.log"), "utf8").catch(() => "");
  /** What Python was asked to do, one call a line (the script's own text in the log is not a call). */
  const pythonCalls = async () => (await calls()).split("\n").filter((line) => line.startsWith("python3 "));

  /**
   * Debian with stand-ins for apt, Node and Python: `python3 -m venv` makes the
   * folder, pip "installs" by writing the imy command, and marker files in the
   * fake phone make a step fail the way it does on a real one.
   */
  async function fakeDebian() {
    await fake("proot-distro", [
      `echo "proot-distro $*" >> "${root}/calls.log"`,
      `case "$1" in`,
      `  list) [ "\${2:-}" = "--installed" ] && echo "debian"; exit 0;;`,
      // login debian [--bind <files>] -- bash -lc <script>
      `  login) shift 2; [ "$1" = --bind ] && shift 2; shift`,
      // The machine running the tests has a Node of its own on PATH: the marker file hides it from the last check.
      `    case "$3" in *"; command -v node >/dev/null 2>&1") [ -f "${root}/no-node" ] && exit 1;; esac`,
      `    [ "$1" = bash ] && [ "$2" = -lc ] && exec bash -c "$3"; exec "$@";;`,
      `esac`,
    ].join("\n"));
    await fake("apt-get", "exit 0", debian());
    await fake("curl", "exit 0", debian());
    await fake("node", "echo true", debian());
    await fakePython(debian());
  }

  async function fakePython(dir: string) {
    await fake("python3", [
      `echo "python3 $*" >> "${root}/calls.log"`,
      `case "$1 $2" in`,
      `  "-c "*) [ -f "${root}/old-python" ] && exit 1; exit 0;;`,
      `  "-m venv") dir="\${@: -1}"; mkdir -p "$dir/bin"; cp "$0" "$dir/bin/python"; exit 0;;`,
      `  "-m pip")`,
      `    case "$*" in`,
      `      *--version*) [ -f "${root}/broken-venv" ] && { rm -f "${root}/broken-venv"; exit 1; }; exit 0;;`,
      `      *"--upgrade pip") [ -f "${root}/offline" ] && exit 1; exit 0;;`,
      `      *) [ -f "${root}/pip-fails" ] && exit 1`,
      `         venv="$(dirname "$(dirname "$0")")"`,
      `         printf '#!/usr/bin/env bash\\necho "imy 9.9.9"\\n' > "$venv/bin/imy"; chmod 755 "$venv/bin/imy"; exit 0;;`,
      `    esac;;`,
      `esac`,
    ].join("\n"), dir);
  }

  async function shippedWheel() {
    const wheels = (await readdir(path.join(SCRIPTS, "terminals", "imy"))).filter((name) => name.endsWith(".whl"));
    expect(wheels).toHaveLength(1);
    return path.join(SCRIPTS, "terminals", "imy", wheels[0]!);
  }

  it("installs the wheel Automa ships into a virtual environment in Debian, then updates it in place", async () => {
    await fakeDebian();
    const wheel = await shippedWheel();
    const venv = path.join(home(), ".local", "share", "imy-venv");

    const first = await run("terminals/linux-setup.sh", ["install", "imy"]);
    expect(first.out).toContain("Installing IMY");
    expect(first.out).toContain("imy 9.9.9");
    expect(first.out).toContain("Done. Open imy from the Terminals screen.");
    expect(first.code).toBe(0);
    const log = await calls();
    // The files tree is bound in, so Debian can read the wheel where Automa keeps it.
    expect(log).toContain(`proot-distro login debian --bind ${path.dirname(prefix)} -- bash -lc`);
    expect(await pythonCalls()).toContain(`python3 -m venv ${venv}`);
    expect(await pythonCalls()).toContain(`python3 -m pip install --quiet --disable-pip-version-check --upgrade ${wheel}`);
    expect(await readFile(path.join(home(), ".local", "bin", "imy"), "utf8")).toContain("imy 9.9.9");

    // A second run is an update: the environment is kept, and a pip that cannot be refreshed does not stop it.
    await writeFile(path.join(root, "offline"), "");
    await writeFile(path.join(root, "calls.log"), "");
    const second = await run("terminals/linux-setup.sh", ["install", "imy"]);
    expect(second.out).toContain("Updating IMY");
    expect(second.out).not.toContain("Installing IMY");
    expect(second.code).toBe(0);
    expect((await pythonCalls()).filter((line) => line.startsWith("python3 -m venv"))).toEqual([]);
    expect(await pythonCalls()).toContain(`python3 -m pip install --quiet --disable-pip-version-check --upgrade ${wheel}`);
  });

  it("starts the virtual environment again when an older Python left it without pip", async () => {
    await fakeDebian();
    expect((await run("terminals/linux-setup.sh", ["install", "imy"])).code).toBe(0);
    await writeFile(path.join(root, "broken-venv"), "");
    await writeFile(path.join(root, "calls.log"), "");
    const result = await run("terminals/linux-setup.sh", ["install", "imy"]);
    expect(result.code).toBe(0);
    expect(await pythonCalls()).toContain(`python3 -m venv --clear ${path.join(home(), ".local", "share", "imy-venv")}`);
  });

  it("says why when Debian's Python is too old, or the package does not install", async () => {
    await fakeDebian();
    await writeFile(path.join(root, "old-python"), "");
    const old = await run("terminals/linux-setup.sh", ["install", "imy"]);
    expect(old.out).toContain("IMY needs Python 3.11 or newer, and Debian's is older");
    expect(old.out).not.toContain("Done.");
    expect(old.code).toBe(1);

    await rm(path.join(root, "old-python"));
    await writeFile(path.join(root, "pip-fails"), "");
    const failed = await run("terminals/linux-setup.sh", ["install", "imy"]);
    expect(failed.out).toContain("IMY did not install. Check the connection and free space, then try again.");
    expect(failed.out).not.toContain("Done.");
    expect(failed.code).toBe(1);
  });

  it("installs straight into the home folder on a computer, with no Linux layer", async () => {
    await fakePython(bin);
    const wheel = await shippedWheel();
    const result = await runFile(path.join(SCRIPTS, "terminals", "linux-setup.sh"), ["install", "imy"], { env: { PREFIX: "" } });
    expect(result.out).toContain("Installing IMY");
    expect(result.out).toContain("imy 9.9.9");
    expect(result.code).toBe(0);
    expect(await calls()).not.toContain("proot-distro");
    expect(await pythonCalls()).toContain(`python3 -m venv ${path.join(home(), ".local", "share", "imy-venv")}`);
    expect(await pythonCalls()).toContain(`python3 -m pip install --quiet --disable-pip-version-check --upgrade ${wheel}`);
    expect(await readFile(path.join(home(), ".local", "bin", "imy"), "utf8")).toContain("imy 9.9.9");

    await writeFile(path.join(root, "old-python"), "");
    const old = await runFile(path.join(SCRIPTS, "terminals", "linux-setup.sh"), ["install", "imy"], { env: { PREFIX: "" } });
    expect(old.out).toContain("IMY needs Python 3.11 or newer; this computer has Python");
    expect(old.code).toBe(1);
  });

  it("warns that the free models need Node.js when Debian has none, and still finishes", async () => {
    await fakeDebian();
    await writeFile(path.join(root, "no-node"), "");
    const result = await run("terminals/linux-setup.sh", ["install", "imy"]);
    expect(result.out).toContain("Debian has no Node.js, which its free models need");
    expect(result.out).toContain("imy init");
    expect(result.out).toContain("Done. Open imy from the Terminals screen.");
    expect(result.code).toBe(0);
  });
});

describe("automa-adb-link.sh", () => {
  it("stops with a clear reason when there is no terminal to type the numbers in", async () => {
    await fake("adb", `case "$1" in devices) echo "List of devices attached";; esac; exit 0`);
    // setsid: no controlling terminal, as when an agent or the app runs it.
    const result = await runFile(path.join(MOBILE_TERMUX, "automa-adb-link.sh"), [], { command: ["setsid", "-w", "timeout", "-s", "KILL", "20", "bash"] });
    expect(result.code).toBe(1);
    expect(result.out).toContain("run it in the Termux app");
  });
});

describe("linux-setup.sh in a narrow terminal", () => {
  const script = path.join(SCRIPTS, "terminals", "linux-setup.sh");
  /** What a terminal that wide shows: the script runs under Automa's own relay; colours and carriage returns removed. */
  async function shown(cols: number, args: string[]) {
    const relay = ["python3", path.join(SCRIPTS, "terminals", "pty-relay.py"), String(cols), "24", "--", "bash"];
    const result = await runFile(script, args, { command: relay, env: { PREFIX: "" } });
    // eslint-disable-next-line no-control-regex
    const lines = result.out.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "").split("\n").filter(Boolean);
    return { code: result.code, lines };
  }

  it("folds its own messages between words, the next lines set under the text", async () => {
    // A phone's terminal: left alone, it would cut "install." and "Terminals" in the middle.
    const narrow = await shown(30, ["install", "shell"]);
    expect(narrow.lines).toEqual(["==> The shell needs no", "    install.", "==> Done. Open shell from the", "    Terminals screen."]);
    expect(narrow.code).toBe(0);
    // A warning reaches the same terminal on its other channel and is folded the same way.
    const usage = await shown(30, []);
    expect(usage.lines).toEqual(["! usage: linux-setup.sh setup", "  | install <tool>"]);
    expect(usage.code).toBe(2);
  });

  it("leaves a message whole where it fits, and where it is not going to a terminal", async () => {
    const whole = ["==> The shell needs no install.", "==> Done. Open shell from the Terminals screen."];
    expect((await shown(120, ["install", "shell"])).lines).toEqual(whole);
    const piped = await runFile(script, ["install", "shell"], { env: { PREFIX: "" } });
    // eslint-disable-next-line no-control-regex
    expect(piped.out.replace(/\x1b\[[0-9;]*m/g, "").split("\n").filter(Boolean)).toEqual(whole);
  });
});

describe("pty-relay.py", () => {
  it("rests instead of spinning once Automa's end of the pipes closes", async () => {
    const relay = spawn("python3", [path.join(SCRIPTS, "terminals", "pty-relay.py"), "80", "24", "--", "sleep", "5"], {
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    try {
      relay.stdout.resume();
      relay.stderr.resume();
      // What the relay sees when the Automa server stops: stdin and the resize channel end.
      relay.stdin.end();
      (relay.stdio[3] as NodeJS.WritableStream).end();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const fields = (await readFile(`/proc/${relay.pid}/stat`, "utf8")).split(") ")[1]!.split(" ");
      // utime + stime in clock ticks (100 a second): starting Python costs a few, a busy loop ~200.
      const ticks = Number(fields[11]) + Number(fields[12]);
      expect(ticks).toBeLessThan(40);
    } finally {
      relay.kill("SIGKILL");
    }
  });
});

describe("openQuickTunnel", () => {
  it("does not report the end of a tunnel that never gave a link", async () => {
    await fake("cloudflared", "exec sleep 30");
    process.env.PAPERCLIP_CLOUDFLARED_PATH = path.join(bin, "cloudflared");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onExit = vi.fn();
    const opening = openQuickTunnel(4321, onExit);
    const failed = expect(opening).rejects.toThrow("did not give a link within a minute");
    await vi.advanceTimersByTimeAsync(60_000);
    await failed;
    vi.useRealTimers();
    // The killed cloudflared exits a moment later; a link opened since must keep its state.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(onExit).not.toHaveBeenCalled();
  });
});

describe("the automa command's backup and restore", () => {
  const COMPLETE_DUMP = "-- PostgreSQL database dump\nCREATE TABLE companies (id uuid);\n--\n-- PostgreSQL database dump complete\n--\n\n\\unrestrict k\n\n";
  const automa = () => path.join(prefix, "bin", "automa");
  const backups = () => path.join(root, "paperclip", "instances", "default", "data", "backups");
  const calls = () => readFile(path.join(root, "calls.log"), "utf8").catch(() => "");

  /** Runs the real installer in the fake phone, with stand-ins for Node, PostgreSQL and npm. */
  async function installAutoma({ nodeMissing = false, pgMajor = 17, env = {} as Record<string, string>, beforeInstall = async () => {} } = {}) {
    const bundle = path.join(root, "bundle");
    await mkdir(path.join(bundle, "packages", "server", "package"), { recursive: true });
    await writeFile(path.join(bundle, "packages", "server", "package", "package.json"), "{}\n");
    await writeFile(path.join(bundle, "VERSION"), "9.9.9\n");
    for (const name of ["install.sh", "automa-adb-link.sh", "automa-follow-start.mjs", "automa-keep-alive.sh", "automa-troubleshoot.sh"]) {
      await copyFile(path.join(MOBILE_TERMUX, name), path.join(bundle, name));
    }
    await mkdir(path.join(root, "pgdata"), { recursive: true });
    await mkdir(path.join(root, "tmp"), { recursive: true });
    await writeFile(path.join(root, "pgdata", "PG_VERSION"), `${pgMajor}\n`);
    await writeFile(path.join(root, "pgdata", "pg_hba.conf"), "host all all 127.0.0.1/32 scram-sha-256\n");
    await writeFile(path.join(root, "pkg-works"), "");
    await symlink("/bin/bash", path.join(prefix, "bin", "bash"));
    // Without Node, pkg installs it (the stand-in) when asked for nodejs-lts.
    // The launcher's own follow script, and the troubleshooter's health check,
    // run on the real Node. The server is a stand-in that logs its start (with
    // what the launcher hands it) and ends with the next code in server-exits,
    // else the one in server-exit (0); with server-blocks it runs until stopped.
    await fake("node", [
      `case "$*" in`,
      `  *automa-follow-start.mjs*|*AbortSignal.timeout*) exec "${process.execPath}" "$@";;`,
      `  *dist/index.js*)`,
      `    echo "server $* safe=\${PAPERCLIP_SAFE_MODE:-} reason=\${AUTOMA_SAFE_REASON:-} launcher=\${AUTOMA_LAUNCHER:-} pool=\${DATABASE_POOL_MAX:-} idle=\${DATABASE_IDLE_TIMEOUT_SECONDS:-} migrate=\${PAPERCLIP_MIGRATION_AUTO_APPLY:-}" >> "${root}/calls.log"`,
      `    if [ -f "${root}/server-blocks" ]; then sleep 300 & nap=$!; trap 'kill $nap 2>/dev/null; exit 0' TERM; wait $nap; exit 0; fi`,
      `    if [ -s "${root}/server-exits" ]; then code="$(head -n 1 "${root}/server-exits")"; sed -i 1d "${root}/server-exits"; exit "$code"; fi`,
      `    exit "$(cat "${root}/server-exit" 2>/dev/null || echo 0)";;`,
      `  *process.versions*) cat "${root}/node-version" 2>/dev/null || echo 24.11.1;;`,
      `  *process.platform*) echo linux;;`,
      `  --version) echo "v$(cat "${root}/node-version" 2>/dev/null || echo 24.11.1)";;`,
      `  *) [ -f "${root}/server-up" ];;`,
      `esac`,
    ].join("\n"), nodeMissing ? path.join(root, "pkg-files") : bin);
    if (nodeMissing) await fake("pkg", `echo "pkg $*" >> "${root}/calls.log"; case " $* " in *" nodejs-lts "*) cp "${root}/pkg-files/node" "${prefix}/bin/node";; esac`);
    // pg_ctl logs what it is asked (status checks aside); a database that
    // won't start is pg-start-fails.
    await fake("pg_ctl", [
      `[ "$1" = --version ] && { echo "pg_ctl (PostgreSQL) ${pgMajor}.6"; exit 0; }`,
      `case " $* " in *" status "*) [ -f "${root}/pg-down" ] && exit 3; exit 0;; esac`,
      `echo "pg_ctl $*" >> "${root}/calls.log"`,
      `case " $* " in *" start "*|*" restart "*) [ -f "${root}/pg-start-fails" ] && exit 1; rm -f "${root}/pg-down";; esac`,
      `exit 0`,
    ].join("\n"));
    // max_parallel_workers: 0 once the phone settings apply (pg-untuned: 8, as PostgreSQL's own).
    // io_method (PostgreSQL 18 on): whatever pg-io-method holds, else none (17 and older).
    await fake("psql", [
      `echo "psql $*" >> "${root}/calls.log"`,
      `case "$*" in`,
      `  *--quiet*) cat > "${root}/restored.sql";;`,
      `  *io_method*) if [ -f "${root}/pg-untuned" ]; then w=8; else w=0; fi; echo "$w|$(cat "${root}/pg-io-method" 2>/dev/null)";;`,
      `  *max_parallel_workers*) if [ -f "${root}/pg-untuned" ]; then echo 8; else echo 0; fi;;`,
      `  *) echo 1;;`,
      `esac`,
    ].join("\n"));
    await fake("createdb", `echo "createdb $*" >> "${root}/calls.log"`);
    await fake("dropdb", `echo "dropdb $*" >> "${root}/calls.log"`);
    await fake("pg_dump", [
      `echo "pg_dump $*" >> "${root}/calls.log"`,
      `echo "-- PostgreSQL database dump"; echo "CREATE TABLE companies (id uuid);"`,
      `[ -f "${root}/pg_dump-fails" ] && { echo "pg_dump: error: could not write to output file: No space left on device" >&2; exit 1; }`,
      `echo "--"; echo "-- PostgreSQL database dump complete"; echo "--"`,
    ].join("\n"));
    await fake("npm", `while [ $# -gt 0 ]; do [ "$1" = --prefix ] && dir="$2"; shift; done; mkdir -p "$dir/node_modules/paperclipai/dist"; touch "$dir/node_modules/paperclipai/dist/index.js"`);
    await beforeInstall();
    const installed = await runFile(path.join(bundle, "install.sh"), [], { env: { AUTOMA_INSTALL_NO_START: "1", ...env } });
    expect(installed.out).toContain("Installed.");
    expect(installed.code).toBe(0);
    return installed;
  }

  async function writeBackup(name: string, sql: string, ageMinutes: number) {
    await mkdir(backups(), { recursive: true });
    const file = path.join(backups(), name);
    await writeFile(file, gzipSync(sql));
    const when = new Date(Date.now() - ageMinutes * 60_000);
    await utimes(file, when, when);
    return file;
  }

  it("installs only what is missing, so PostgreSQL is never upgraded under the database", async () => {
    await installAutoma({ nodeMissing: true });
    const installs = (await calls()).split("\n").filter((line) => line.startsWith("pkg install"));
    expect(installs).toContain("pkg install -y nodejs-lts git");
    expect(installs.join("\n")).not.toContain("postgresql");
  }, 60_000);

  it("refuses a Node.js older than 24.11 before it changes anything, as the server would refuse it at its first start", async () => {
    await installAutoma();
    const install = () => runFile(path.join(root, "bundle", "install.sh"), [], { env: { AUTOMA_INSTALL_NO_START: "1" } });
    await writeFile(path.join(root, "node-version"), "24.10.0\n");
    const refused = await install();
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("Automa needs Node.js 24.11 or newer (found v24.10.0). Run: pkg upgrade -y");
    expect(refused.out).not.toContain("Setting up the database");
    for (const version of ["24.11.0", "25.0.0"]) {
      await writeFile(path.join(root, "node-version"), `${version}\n`);
      const accepted = await install();
      expect(accepted.code, `${version}: ${accepted.out}`).toBe(0);
      expect(accepted.out).not.toContain("Automa needs Node.js");
    }
  }, 60_000);

  it("automa link opens the app with a MAIN intent and the app key", async () => {
    await installAutoma();
    await fake("am", `echo "am $*" >> "${root}/calls.log"`);
    const result = await runFile(automa(), ["link"]);
    expect(result.code).toBe(0);
    expect(await calls()).toMatch(/am start -a android\.intent\.action\.MAIN -n com\.corxlabs\.automa\/\.MainActivity --es com\.corxlabs\.automa\.CONNECT http:\/\/127\.0\.0\.1:3100 --es com\.corxlabs\.automa\.SECRET [0-9a-f]{48}\n/);
  }, 60_000);

  it("keeps the database password and the app key owner-only (0600), even if an older install left one readable", async () => {
    const dbPassword = path.join(root, "home", ".automa", "db-password");
    const appSecret = path.join(root, "home", ".automa", "app-secret");
    // An older installer left the app key world-readable; a secret file from
    // before this install exists with loose perms.
    await mkdir(path.join(root, "home", ".automa"), { recursive: true });
    await writeFile(appSecret, "0".repeat(48));
    await chmod(appSecret, 0o644);
    await installAutoma();
    // Both secrets exist, hold a 48-hex value, and are mode 0600 (no group/other bits).
    for (const file of [dbPassword, appSecret]) {
      expect((await readFile(file, "utf8")).trim()).toMatch(/^[0-9a-f]{48}$/);
      expect((await stat(file)).mode & 0o077).toBe(0);
    }
  }, 60_000);

  it("automa backup fails loudly and leaves no half backup when the dump fails", async () => {
    await installAutoma();
    await writeFile(path.join(root, "pg_dump-fails"), "");
    const failed = await runFile(automa(), ["backup"]);
    expect(failed.code).toBe(1);
    expect(failed.out).toContain("No backup was saved");
    expect(await readdir(backups())).toEqual([]);

    await rm(path.join(root, "pg_dump-fails"));
    const saved = await runFile(automa(), ["backup"]);
    expect(saved.code).toBe(0);
    const files = await readdir(backups());
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^automa-manual-.*\.sql\.gz$/);
  }, 60_000);

  it("automa restore passes over a backup that was cut short", async () => {
    await installAutoma();
    // Automa's own hourly backup (the server's format), then a newer one cut short.
    await writeBackup("paperclip-20261001-000000.sql.gz", "-- Paperclip database backup\nBEGIN;\nCREATE TABLE companies (id uuid);\nCOMMIT;\n-- paperclip statement breakpoint\n\n", 60);
    const cut = await writeBackup("automa-manual-20261002-000000.sql.gz", "-- PostgreSQL database dump\nCREATE TABLE companies (id uuid);\n", 5);
    const result = await runFile(automa(), ["restore", "--yes"]);
    expect(result.out).toContain(`Skipping ${cut}`);
    expect(result.code).toBe(0);
    expect(await readFile(path.join(root, "restored.sql"), "utf8")).toContain("-- Paperclip database backup");
    // The database it replaced was kept first.
    expect(result.out).toMatch(/The copy from before this restore is .*automa-before-restore-/);
  }, 60_000);

  it("automa restore refuses a damaged backup it is given", async () => {
    await installAutoma();
    const cut = await writeBackup("automa-manual-20261002-000000.sql.gz", "-- PostgreSQL database dump\nCREATE TABLE companies (id uuid);\n", 5);
    const result = await runFile(automa(), ["restore", cut, "--yes"]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("is not a complete backup");
    expect(await calls()).not.toContain("dropdb");
  }, 60_000);

  it("automa restore changes nothing when it can't keep a copy of the current database", async () => {
    await installAutoma();
    const good = await writeBackup("automa-manual-20261002-000000.sql.gz", COMPLETE_DUMP, 5);
    await writeFile(path.join(root, "pg_dump-fails"), "");
    const result = await runFile(automa(), ["restore", good, "--yes"]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("Nothing changed");
    expect(await calls()).not.toContain("dropdb");
    expect((await readdir(backups())).filter((name) => name.startsWith("automa-before-restore"))).toEqual([]);
  }, 60_000);

  describe("updating the server", () => {
    const serverDir = () => path.join(root, "home", ".automa", "server");
    const npmCalls = async () => (await calls()).split("\n").filter((line) => line.startsWith("npm install")).length;
    let running: ReturnType<typeof spawn> | null = null;
    afterEach(() => {
      running?.kill("SIGKILL");
      running = null;
    });

    /** 9.9.9 installed and running (a stand-in process), then a 9.9.10 bundle whose npm fails `failures` times. */
    async function updateWithFailingDownloads(failures: number, version = "9.9.10") {
      await installAutoma();
      await writeFile(path.join(serverDir(), "old-server"), "9.9.9");
      // Named like the launcher's own process: only a real Automa is stopped.
      running = spawn("sleep", ["300"], { stdio: "ignore", argv0: "automa-run" });
      await writeFile(path.join(root, "home", ".automa", "automa.pid"), `${running.pid}\n`);
      await writeFile(path.join(root, "bundle", "VERSION"), `${version}\n`);
      await writeFile(path.join(root, "npm-failures"), String(failures));
      await fake("npm", [
        `echo "npm $*" >> "${root}/calls.log"`,
        `left=$(cat "${root}/npm-failures")`,
        `if [ "$left" -gt 0 ]; then echo $((left - 1)) > "${root}/npm-failures"; echo "npm error code ETIMEDOUT" >&2; echo "npm error network read ETIMEDOUT" >&2; exit 1; fi`,
        `while [ $# -gt 0 ]; do [ "$1" = --prefix ] && dir="$2"; shift; done; mkdir -p "$dir/node_modules/paperclipai/dist"; touch "$dir/node_modules/paperclipai/dist/index.js"`,
      ].join("\n"));
      // What the update itself does is logged after this line.
      await writeFile(path.join(root, "calls.log"), `${await calls()}=== update\n`);
      return runFile(path.join(root, "bundle", "install.sh"), [], { env: { AUTOMA_INSTALL_NO_START: "1", AUTOMA_NPM_RETRY_WAIT: "0" } });
    }
    const updateCalls = async () => (await calls()).split("=== update\n")[1] ?? "";

    const alive = (pid: number | undefined) => {
      try {
        process.kill(pid!, 0);
        return true;
      } catch {
        return false;
      }
    };

    it("leaves the old server installed and running when the download keeps failing", async () => {
      await fake("termux-wake-lock", `echo "termux-wake-lock" >> "${root}/calls.log"`);
      await fake("termux-wake-unlock", `echo "termux-wake-unlock" >> "${root}/calls.log"`);
      const result = await updateWithFailingDownloads(3);
      expect(result.code).toBe(1);
      // Termux has one wake lock: the server still running keeps it.
      expect(await updateCalls()).toContain("termux-wake-lock");
      expect(await updateCalls()).not.toContain("termux-wake-unlock");
      expect(result.out).toContain("Nothing was changed: Automa 9.9.9 is still installed");
      expect(result.out).not.toContain("Stopping the running Automa server");
      expect(await npmCalls()).toBe(3);
      expect(alive(running!.pid)).toBe(true);
      expect((await readFile(path.join(serverDir(), ".automa-version"), "utf8")).trim()).toBe("9.9.9");
      expect(await readFile(path.join(serverDir(), "old-server"), "utf8")).toBe("9.9.9");
      expect(await readdir(path.join(root, "home", ".automa"))).not.toContain("server.next");
    }, 60_000);

    it("tries a stalled download again, then stops the old server and switches to the new one", async () => {
      const result = await updateWithFailingDownloads(1, "9.9.10 (abc1234)");
      expect(result.code, result.out).toBe(0);
      // The copy made before the update has a name with no spaces or brackets.
      expect((await readdir(backups())).filter((name) => name.startsWith("automa-before-"))).toEqual([
        expect.stringMatching(/^automa-before-9\.9\.10-abc1234-\d{8}-\d{6}\.sql\.gz$/),
      ]);
      expect(result.out).toContain("trying again (2 of 3)");
      expect(result.out).toContain("Stopping the running Automa server");
      expect(await npmCalls()).toBe(2);
      await vi.waitFor(() => expect(alive(running!.pid)).toBe(false));
      expect((await readFile(path.join(serverDir(), ".automa-version"), "utf8")).trim()).toBe("9.9.10 (abc1234)");
      expect(await readdir(path.join(root, "home", ".automa"))).not.toEqual(expect.arrayContaining(["server.next"]));
      expect(await readdir(path.join(root, "home", ".automa"))).not.toEqual(expect.arrayContaining(["server.prev"]));
    }, 60_000);
  });

  describe("updating the server on a phone that is short of storage", () => {
    const serverDir = () => path.join(root, "home", ".automa", "server");
    const automaHome = () => path.join(root, "home", ".automa");
    const npmInstalls = async () => (await calls()).split("=== update\n")[1]!.split("\n").filter((line) => line.startsWith("npm install")).length;
    const after = async () => (await calls()).split("=== update\n")[1] ?? "";
    const MB = 1024;

    /**
     * 9.9.9 installed, then a 9.9.10 bundle on a phone whose free storage is
     * what `free-kb` holds. `df` reads it; emptying npm's cache adds
     * `npm-cache-frees-kb` to it; `npm install` fails for lack of space
     * `npm-enospc` times (each time leaving less than 50 MB free unless
     * `enospc-keeps-free` is there).
     */
    async function shortOfStorage(freeMb: number, options: { cacheFreesMb?: number; enospc?: number } = {}) {
      await installAutoma();
      await writeFile(path.join(serverDir(), "old-server"), "9.9.9");
      await writeFile(path.join(root, "bundle", "VERSION"), "9.9.10\n");
      await writeFile(path.join(root, "free-kb"), String(freeMb * MB));
      await writeFile(path.join(root, "npm-cache-frees-kb"), String((options.cacheFreesMb ?? 0) * MB));
      await writeFile(path.join(root, "npm-enospc"), String(options.enospc ?? 0));
      await mkdir(path.join(root, "home", ".npm", "_cacache", "tmp"), { recursive: true });
      await writeFile(path.join(root, "home", ".npm", "_cacache", "tmp", "half-download"), "x");
      await fake("df", `echo "Filesystem 1024-blocks Used Available Capacity Mounted on"; echo "/dev/block/dm-9 100000000 90000000 $(cat "${root}/free-kb") 99% /data"`);
      await fake("npm", [
        `echo "npm $*" >> "${root}/calls.log"`,
        `if [ "$1" = cache ]; then echo $(( $(cat "${root}/free-kb") + $(cat "${root}/npm-cache-frees-kb") )) > "${root}/free-kb"; echo 0 > "${root}/npm-cache-frees-kb"; exit 0; fi`,
        `left=$(cat "${root}/npm-enospc")`,
        `if [ "$left" -gt 0 ]; then`,
        `  echo $((left - 1)) > "${root}/npm-enospc"`,
        `  [ -f "${root}/enospc-keeps-free" ] || echo ${10 * MB} > "${root}/free-kb"`,
        `  echo "npm error code ENOSPC" >&2; echo "npm error syscall mkdtemp" >&2`,
        `  echo "npm error nospc ENOSPC: no space left on device, mkdtemp '/data/data/com.termux/files/home/.npm/_cacache/tmp/FpkMgQ'" >&2`,
        `  exit 228`,
        `fi`,
        `while [ $# -gt 0 ]; do [ "$1" = --prefix ] && dir="$2"; shift; done; mkdir -p "$dir/node_modules/paperclipai/dist"; touch "$dir/node_modules/paperclipai/dist/index.js"`,
      ].join("\n"));
      await writeFile(path.join(root, "calls.log"), `${await calls()}=== update\n`);
      return runFile(path.join(root, "bundle", "install.sh"), [], { env: { AUTOMA_INSTALL_NO_START: "1", AUTOMA_NPM_RETRY_WAIT: "0", AUTOMA_UPDATE_HEADROOM_MB: "300" } });
    }
    const version = async () => (await readFile(path.join(serverDir(), ".automa-version"), "utf8")).trim();

    it("warns before a first install that the phone is low on storage, and still tries", async () => {
      const installed = await installAutoma({
        env: { AUTOMA_INSTALL_NEED_MB: "900" },
        beforeInstall: () => fake("df", `echo "Filesystem 1024-blocks Used Available Capacity Mounted on"; echo "/dev/block/dm-9 100000000 90000000 ${200 * MB} 99% /data"`),
      });
      expect(installed.out).toContain("Only 200 MB of storage is free, and the install needs about 900 MB. It is tried anyway");
    }, 60_000);

    it("says the storage ran out when the new server cannot be unpacked", async () => {
      await installAutoma();
      await mkdir(path.join(root, "home", "downloads"), { recursive: true });
      await writeFile(path.join(root, "home", "downloads", "automa-server.tar.xz"), "not an archive");
      await fake("df", `echo "Filesystem 1024-blocks Used Available Capacity Mounted on"; echo "/dev/block/dm-9 100000000 90000000 ${12 * MB} 99% /data"`);
      const result = await runFile(automa(), ["update"]);
      expect(result.code).toBe(1);
      expect(result.out).toContain("Could not unpack the new server");
      expect(result.out).toContain("12 MB of storage is free");
      expect(result.out).toContain("free some space first");
      expect(result.out).toContain("tap Send to Termux again");
      // The command ends the message: nothing after it that could be typed as part of it.
      expect(result.out.trimEnd().endsWith("Then run: automa update")).toBe(true);
      expect(await readdir(path.join(root, "tmp")).catch(() => [])).not.toContain("automa-server");
    }, 60_000);

    it("stops before it changes anything when there is no room, and says how much is free and how much it needs", async () => {
      const result = await shortOfStorage(120);
      expect(result.code).toBe(1);
      expect(result.out).toMatch(/Not enough free storage for the update: 120 MB free, about 3\d\d MB needed/);
      expect(result.out).toContain("Nothing was changed: Automa 9.9.9 is still installed");
      // It is the storage, not the connection, and it says what to do about it.
      expect(result.out).not.toContain("connection");
      expect(result.out).toContain("then run: automa update");
      // What is safe to clear was cleared before giving up; nothing was downloaded, nothing backed up into the last room.
      expect(await after()).toContain("npm cache clean --force");
      expect(await npmInstalls()).toBe(0);
      expect(await after()).not.toContain("pg_dump");
      expect(await version()).toBe("9.9.9");
      expect(await readFile(path.join(serverDir(), "old-server"), "utf8")).toBe("9.9.9");
      expect(await readdir(automaHome())).not.toContain("server.next");
    }, 60_000);

    it("makes room by itself when clearing its own leftovers is enough, and then updates", async () => {
      await mkdir(path.join(root, "leftovers"), { recursive: true });
      const result = await shortOfStorage(120, { cacheFreesMb: 900 });
      expect(result.code, result.out).toBe(0);
      expect(result.out).toContain("Storage is low (120 MB free; the update needs about");
      // What it gained is what appeared, measured.
      expect(result.out).toContain("Emptied npm's download cache; the update downloads again what it needs (900 MB)");
      expect(result.out).toContain("Now 1020 MB free");
      expect(await version()).toBe("9.9.10");
      expect(await npmInstalls()).toBe(1);
      // npm's unfinished downloads went as well.
      expect(await readdir(path.join(root, "home", ".npm", "_cacache")).catch(() => [])).not.toContain("tmp");
    }, 60_000);

    it("leaves npm's cache alone while there is room", async () => {
      const result = await shortOfStorage(4000);
      expect(result.code, result.out).toBe(0);
      expect(result.out).not.toContain("Storage is low");
      expect(await after()).not.toContain("npm cache clean");
      expect(await version()).toBe("9.9.10");
    }, 60_000);

    it("says the phone ran out of storage when npm does, instead of blaming the connection and asking three times", async () => {
      const result = await shortOfStorage(4000, { enospc: 5 });
      expect(result.code).toBe(1);
      expect(result.out).toContain("The phone ran out of storage while the update was being prepared");
      expect(result.out).toContain("Nothing was changed: Automa 9.9.9 is still installed");
      // The command ends the message: nothing after it that could be typed as part of it.
      expect(result.out).toMatch(/It needs about 3\d\d MB free and there are 10 MB\. Free some space on the phone \(photos, videos, apps you don't use\), then run: automa update\s*$/);
      // A clean-up that gained nothing is not announced.
      expect(result.out).not.toContain("Emptied npm's download cache");
      expect(result.out).not.toContain("connection timed out or dropped");
      expect(result.out).not.toContain("The download stopped; trying again");
      // Asked once. Clearing what is safe made no room, so it is not asked again: the answer would be the same.
      expect(await npmInstalls()).toBe(1);
      expect(await after()).toContain("npm cache clean --force");
      expect(await version()).toBe("9.9.9");
      expect(await readdir(automaHome())).not.toContain("server.next");
    }, 60_000);

    it("finishes the update when making room after the first failure was enough", async () => {
      const result = await shortOfStorage(4000, { enospc: 1, cacheFreesMb: 900 });
      expect(result.code, result.out).toBe(0);
      expect(result.out).toContain("The phone ran out of storage. Making room and trying once more");
      expect(await npmInstalls()).toBe(2);
      expect(await version()).toBe("9.9.10");
    }, 60_000);

    it("reads npm's own words: out of space is out of space even when room came back after it stopped", async () => {
      await writeFile(path.join(root, "enospc-keeps-free"), "");
      const result = await shortOfStorage(4000, { enospc: 5 });
      expect(result.code).toBe(1);
      expect(result.out).toContain("The phone ran out of storage while the update was being prepared");
      // With room there again, the advice is to try once more, not to free what is already free.
      expect(result.out).toContain("There are 4000 MB free now, so a second try may work.");
      // The command ends the message: nothing after it that could be typed as part of it.
      expect(result.out.trimEnd().endsWith("To try again, run: automa update")).toBe(true);
      expect(result.out).not.toContain("connection timed out or dropped");
    }, 60_000);

    it("keeps one copy of the database per update: a second try replaces the first try's copy, and no other backup", async () => {
      await writeBackup("automa-before-9.9.10-20261001-000000.sql.gz", COMPLETE_DUMP, 600);
      await writeBackup("automa-before-9.9.10-20261001-010000.sql.gz", COMPLETE_DUMP, 540);
      await writeBackup("automa-before-9.9.8-20260901-000000.sql.gz", COMPLETE_DUMP, 90_000);
      await writeBackup("automa-manual-20261001-000000.sql.gz", COMPLETE_DUMP, 600);
      await writeBackup("automa-20261001-000000.sql.gz", COMPLETE_DUMP, 600);
      const result = await shortOfStorage(4000);
      expect(result.code, result.out).toBe(0);
      const kept = (await readdir(backups())).sort();
      expect(kept.filter((name) => name.startsWith("automa-before-9.9.10-"))).toEqual([expect.stringMatching(/^automa-before-9\.9\.10-\d{8}-\d{6}\.sql\.gz$/)]);
      expect(kept.filter((name) => name.startsWith("automa-before-9.9.10-"))[0]).not.toMatch(/20261001/);
      expect(kept).toEqual(expect.arrayContaining(["automa-before-9.9.8-20260901-000000.sql.gz", "automa-manual-20261001-000000.sql.gz", "automa-20261001-000000.sql.gz"]));
    }, 60_000);

    it("keeps the earlier copies when the new copy could not be written", async () => {
      await writeBackup("automa-before-9.9.10-20261001-000000.sql.gz", COMPLETE_DUMP, 600);
      await writeFile(path.join(root, "pg_dump-fails"), "");
      const result = await shortOfStorage(4000);
      expect(result.code, result.out).toBe(0);
      expect(await readdir(backups())).toContain("automa-before-9.9.10-20261001-000000.sql.gz");
    }, 60_000);

    it("never clears the server from before an interrupted update when it is the only one left", async () => {
      await installAutoma();
      // An update stopped in the middle of the switch: the server in use was
      // moved aside and the new one never took its place.
      await rename(serverDir(), `${serverDir()}.prev`);
      await writeFile(path.join(root, "free-kb"), String(40 * MB));
      await fake("df", `echo "Filesystem 1024-blocks Used Available Capacity Mounted on"; echo "/dev/block/dm-9 100000000 90000000 $(cat "${root}/free-kb") 99% /data"`);
      await fake("npm", [
        `echo "npm $*" >> "${root}/calls.log"`,
        `[ "$1" = cache ] && exit 0`,
        `echo "npm error nospc ENOSPC: no space left on device, mkdtemp '/data/data/com.termux/files/home/.npm/_cacache/tmp/FpkMgQ'" >&2`,
        `exit 228`,
      ].join("\n"));
      const result = await runFile(path.join(root, "bundle", "install.sh"), [], { env: { AUTOMA_INSTALL_NO_START: "1", AUTOMA_NPM_RETRY_WAIT: "0", AUTOMA_INSTALL_NEED_MB: "900" } });
      expect(result.code).toBe(1);
      expect(result.out).toContain("The phone ran out of storage while Automa's packages were being installed. It needs about 900 MB free and there are 40 MB.");
      expect(result.out.trimEnd().endsWith("then run this installer again")).toBe(true);
      // Not the connection, and (the cache was emptied to make room) no promise that the downloads were kept.
      expect(result.out).not.toContain("timed out or dropped");
      expect(result.out).not.toContain("what already downloaded is kept");
      // `automa fix` puts this copy back, so making room must leave it.
      expect(await readdir(path.join(`${serverDir()}.prev`, "node_modules", "paperclipai", "dist"))).toContain("index.js");
    }, 60_000);
  });

  it("automa restore waits for an Automa started elsewhere to be stopped", async () => {
    await installAutoma();
    const good = await writeBackup("automa-manual-20261002-000000.sql.gz", COMPLETE_DUMP, 5);
    await writeFile(path.join(root, "server-up"), "");
    const result = await runFile(automa(), ["restore", good, "--yes"]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("Automa is still running");
    expect(await calls()).not.toContain("dropdb");
    // Refused before anything was copied: no new file to be mistaken for the newest backup.
    expect((await readdir(backups())).filter((name) => name.startsWith("automa-before-restore"))).toEqual([]);
  }, 60_000);

  it("automa restore never picks a copy saved before a restore by itself", async () => {
    await installAutoma();
    await writeBackup("automa-manual-20261001-000000.sql.gz", "-- Paperclip database backup\nBEGIN;\nCREATE TABLE chosen (id uuid);\nCOMMIT;\n", 60);
    // The database as it was just before an earlier restore: newer, complete, not a backup to choose.
    await writeBackup("automa-before-restore-20261002-000000.sql.gz", COMPLETE_DUMP, 5);
    const result = await runFile(automa(), ["restore", "--yes"]);
    expect(result.code, result.out).toBe(0);
    expect(await readFile(path.join(root, "restored.sql"), "utf8")).toContain("CREATE TABLE chosen");
  }, 60_000);

  it("never starts a second Automa beside one started another way", async () => {
    await installAutoma();
    await writeFile(path.join(root, "server-up"), "");
    const started = await runFile(automa(), ["start"]);
    expect(started.code).toBe(0);
    expect(started.out).toContain("Automa is already running on http://127.0.0.1:3100 (started another way)");
    // automa run follows that one's start; nothing really answers here, so the
    // follow gives up quickly instead of waiting a minute (or finding whatever
    // else this machine runs on port 3100).
    const ran = await runFile(automa(), ["run"], {
      env: { AUTOMA_HEALTH_URL: "http://127.0.0.1:9/api/health", AUTOMA_FOLLOW_POLL_MS: "20", AUTOMA_FOLLOW_SILENT_MS: "300" },
    });
    expect(ran.code, ran.out).toBe(0);
    expect(ran.out).toContain("started another way");
    await expect(readFile(path.join(root, "home", ".automa", "automa.pid"), "utf8")).rejects.toThrow();
  }, 60_000);

  it("records the server automa onboard starts, so stop and update know about it", async () => {
    await installAutoma();
    // The stand-in server exits at once; what matters is that its pid was kept.
    await runFile(automa(), ["onboard", "--yes"]);
    expect((await readFile(path.join(root, "home", ".automa", "automa.pid"), "utf8")).trim()).toMatch(/^\d+$/);
  }, 60_000);

  describe("an Automa that is already starting", () => {
    const pidFile = () => path.join(root, "home", ".automa", "automa.pid");
    let processes: ReturnType<typeof spawn>[] = [];
    let health: import("node:http").Server | null = null;
    afterEach(async () => {
      for (const child of processes) child.kill("SIGKILL");
      processes = [];
      await new Promise<void>((resolve) => (health ? health.close(() => resolve()) : resolve()));
      health = null;
    });
    const alive = (pid: number | undefined) => {
      try {
        process.kill(pid!, 0);
        return true;
      } catch {
        return false;
      }
    };
    /** A long-running stand-in process; `argv0` is what its command line shows. */
    function background(argv0: string) {
      const child = spawn("sleep", ["300"], { stdio: "ignore", argv0 });
      processes.push(child);
      return child;
    }
    /** A health endpoint that answers each request with the next body (the last one repeats). */
    async function healthAnswers(bodies: unknown[]) {
      const http = await import("node:http");
      let next = 0;
      health = http.createServer((_req, res) => {
        const body = bodies[Math.min(next, bodies.length - 1)];
        next += 1;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body));
      });
      await new Promise<void>((resolve) => health!.listen(0, "127.0.0.1", () => resolve()));
      const { port } = health.address() as { port: number };
      return `http://127.0.0.1:${port}/api/health`;
    }
    const starting = (label: string, number: number) => ({
      status: "starting",
      startup: { phase: "recovering", seconds: 40, step: { id: "x", label, seconds: 3, number, total: 23 } },
    });

    it("automa run follows the one the app started until it is ready, then opens the app", async () => {
      await installAutoma();
      await fake("am", `echo "am $*" >> "${root}/calls.log"`);
      const supervisor = background("automa-run");
      await writeFile(pidFile(), `${supervisor.pid}\n`);
      const url = await healthAnswers([starting("Checking assigned tasks", 13), starting("Tidying up", 18), { status: "ok" }]);

      const ran = await runFile(automa(), ["run"], { env: { AUTOMA_HEALTH_URL: url, AUTOMA_FOLLOW_POLL_MS: "20" } });

      expect(ran.code, ran.out).toBe(0);
      expect(ran.out).toContain("Automa is already running in the background");
      expect(ran.out).toContain("Automa is starting up: Checking assigned tasks (step 13 of 23)…");
      expect(ran.out).toContain("Automa is starting up: Tidying up (step 18 of 23)…");
      expect(ran.out).toContain("Automa is running and ready on http://127.0.0.1:3100");
      // Asked once on the way in, and again the moment it is ready.
      expect((await calls()).match(/am start .*com\.corxlabs\.automa\.CONNECT/g)).toHaveLength(2);
      // The running one is left alone; no second one was started.
      expect(alive(supervisor.pid)).toBe(true);
      expect(await calls()).not.toContain("server ");
    }, 60_000);

    it("automa status says which step a starting Automa is on", async () => {
      await installAutoma();
      const url = await healthAnswers([starting("Resuming agent goals", 11)]);
      const status = await runFile(automa(), ["status"], { env: { AUTOMA_HEALTH_URL: url } });
      expect(status.code).toBe(1);
      expect(status.out).toContain("Automa is starting up: Resuming agent goals (step 11 of 23)…");

      const ready = await runFile(automa(), ["status"], { env: { AUTOMA_HEALTH_URL: await healthAnswers([{ status: "ok" }]) } });
      expect(ready.code).toBe(0);
      expect(ready.out).toContain("running and ready");
    }, 60_000);

    it("never signals a process that only took over Automa's old number, and starts Automa", async () => {
      await installAutoma();
      // Android ended Termux; the number in automa.pid now belongs to something else.
      const stranger = background("sleep");
      await writeFile(pidFile(), `${stranger.pid}\n`);

      const stopped = await runFile(automa(), ["stop"]);
      expect(stopped.out).toContain("Automa is not running in the background.");
      expect(alive(stranger.pid)).toBe(true);
      await expect(readFile(pidFile(), "utf8")).rejects.toThrow();

      await writeFile(pidFile(), `${stranger.pid}\n`);
      const ran = await runFile(automa(), ["run"]);
      expect(ran.out).not.toContain("already running");
      // The stand-in server ran (and ended cleanly, which ends automa run).
      expect(await calls()).toContain("server ");
      expect(ran.code, ran.out).toBe(0);
      expect(alive(stranger.pid)).toBe(true);
    }, 60_000);

    it("clears PostgreSQL's lock file left from before, but never a running PostgreSQL's", async () => {
      await installAutoma();
      const lock = path.join(root, "pgdata", "postmaster.pid");
      const stranger = background("sleep");
      await writeFile(lock, `${stranger.pid}\n${path.join(root, "pgdata")}\n`);
      const saved = await runFile(automa(), ["backup"]);
      expect(saved.code, saved.out).toBe(0);
      expect(saved.out).toContain("Clearing PostgreSQL's lock file left from before");
      await expect(readFile(lock, "utf8")).rejects.toThrow();

      const postgres = background("postgres");
      await writeFile(lock, `${postgres.pid}\n${path.join(root, "pgdata")}\n`);
      const again = await runFile(automa(), ["backup"]);
      expect(again.code, again.out).toBe(0);
      expect(again.out).not.toContain("Clearing PostgreSQL's lock file");
      expect(await readFile(lock, "utf8")).toContain(String(postgres.pid));
    }, 60_000);

    /** `automa <args>` running in the background, with what it prints so far. */
    function supervise(args: string[], env: Record<string, string> = {}) {
      const child = spawn("bash", [automa(), ...args], { env: phoneEnv(env), cwd: root, stdio: ["ignore", "pipe", "pipe"] });
      processes.push(child);
      const output = { text: "" };
      child.stdout!.on("data", (chunk) => { output.text += String(chunk); });
      child.stderr!.on("data", (chunk) => { output.text += String(chunk); });
      const ended = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
      return { child, output, ended };
    }
    const serverStarts = async () => (await calls()).split("\n").filter((line) => line.startsWith("server "));
    const events = () => readFile(path.join(root, "home", ".automa", "events.log"), "utf8").catch(() => "");

    it("starts in safe mode after three quick stops, slows down only when even that keeps stopping, and automa stop ends the wait at once", async () => {
      await installAutoma();
      await writeFile(path.join(root, "server-exit"), "1");
      const { output, ended } = supervise(["run"], { AUTOMA_RESTART_WAIT: "0" });

      await vi.waitFor(() => expect(output.text).toContain("Trying again in 60 seconds"), { timeout: 30_000, interval: 100 });
      expect(output.text).toContain("Automa stopped 3 times in a row while starting (exit 1). Starting it in safe mode");
      expect(output.text).toContain("Automa stopped 3 times in a row while starting, even in safe mode (exit 1)");
      const starts = await serverStarts();
      expect(starts).toHaveLength(6);
      // Three normal starts, then three safe ones that say why; --safe is never the server's.
      for (const line of starts.slice(0, 3)) expect(line).toContain("safe= reason= launcher=1");
      for (const line of starts.slice(3)) expect(line).toContain("safe=1 reason=crashes launcher=1");
      expect(await events()).toContain("falling back to safe mode after 3 quick stops");

      const stop = await runFile(automa(), ["stop"]);
      expect(stop.out).toContain("Automa stopped.");
      const started = Date.now();
      expect(await ended).toBe(0);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(await serverStarts()).toHaveLength(6);
    }, 60_000);

    it("starts normally again at once when the board asks (exit 75), and stays normal", async () => {
      await installAutoma();
      // Three quick stops, the fallback safe start, then Restart normally on the board.
      await writeFile(path.join(root, "server-exits"), "1\n1\n1\n75\n0\n");
      const { output, ended } = supervise(["run"], { AUTOMA_RESTART_WAIT: "0" });
      expect(await ended).toBe(0);
      const starts = await serverStarts();
      expect(starts).toHaveLength(5);
      expect(starts[3]).toContain("safe=1 reason=crashes");
      expect(starts[4]).toContain("safe= reason= launcher=1");
      expect(output.text).toContain("Restarting Automa normally, as asked on the board");
      expect(await events()).toContain("restarting normally, as asked on the board");
    }, 60_000);

    it("automa run --safe and automa start --safe start in safe mode, and the server never sees --safe", async () => {
      await installAutoma();
      const ran = await runFile(automa(), ["run", "--safe"]);
      expect(ran.code, ran.out).toBe(0);
      expect(ran.out).toContain("Starting Automa in safe mode");
      let starts = await serverStarts();
      expect(starts).toHaveLength(1);
      expect(starts[0]).toContain("safe=1 reason=asked launcher=1");
      expect(starts[0]).not.toContain("--safe");
      expect(starts[0]).toMatch(/^server \S*dist\/index\.js run safe=/);

      const started = await runFile(automa(), ["start", "--safe"]);
      expect(started.out).toContain("Automa is starting in safe mode");
      await vi.waitFor(async () => expect(await serverStarts()).toHaveLength(2), { timeout: 20_000, interval: 100 });
      starts = await serverStarts();
      expect(starts[1]).toContain("safe=1 reason=asked launcher=1");
      expect(starts[1]).not.toContain("--safe");
    }, 60_000);

    it("every way of starting Automa applies a new version's database changes without asking, unless the person chose otherwise", async () => {
      await installAutoma();
      // Asked on a terminal (automa onboard runs in the foreground), Enter
      // meant No and the first start after an update stopped there.
      const onboarded = await runFile(automa(), ["onboard", "--yes"]);
      expect(onboarded.code, onboarded.out).toBe(0);
      const ran = await runFile(automa(), ["run"]);
      expect(ran.code, ran.out).toBe(0);
      const safe = await runFile(automa(), ["run", "--safe"]);
      expect(safe.code, safe.out).toBe(0);
      const kept = await runFile(automa(), ["run"], { env: { PAPERCLIP_MIGRATION_AUTO_APPLY: "false" } });
      expect(kept.code, kept.out).toBe(0);
      const started = await runFile(automa(), ["start"]);
      expect(started.out).toContain("Automa is starting (log:");
      await vi.waitFor(async () => expect(await serverStarts()).toHaveLength(5), { timeout: 20_000, interval: 100 });

      const starts = await serverStarts();
      expect(starts[0]).toMatch(/dist\/index\.js onboard --yes .* migrate=true$/);
      // Nothing starts that one again when it exits, so it is not the launcher's.
      expect(starts[0]).toContain(" launcher= ");
      expect(starts[1]).toMatch(/dist\/index\.js run .* migrate=true$/);
      expect(starts[2]).toMatch(/safe=1 reason=asked .* migrate=true$/);
      // A value the person set is theirs.
      expect(starts[3]).toMatch(/ migrate=false$/);
      expect(starts[4]).toMatch(/dist\/index\.js run .* migrate=true$/);
    }, 60_000);

    it("the installer's own last step starts the updated server so that it applies the new version's database changes", async () => {
      await installAutoma();
      await writeFile(path.join(root, "bundle", "VERSION"), "9.9.10\n");
      // An update as automa update runs it: to the end, starting Automa.
      const updated = await runFile(path.join(root, "bundle", "install.sh"), []);
      expect(updated.code, updated.out).toBe(0);
      expect(updated.out).toContain("Updating the Automa server 9.9.9 -> 9.9.10");
      expect((await readdir(backups())).filter((name) => name.startsWith("automa-before-9.9.10-"))).toHaveLength(1);
      const starts = await serverStarts();
      expect(starts).toHaveLength(1);
      expect(starts[0]).toMatch(/dist\/index\.js onboard --yes .* migrate=true$/);
    }, 60_000);

    it("says Android ended the server (signal 9) and what stops that, and keeps a record", async () => {
      await installAutoma();
      await writeFile(path.join(root, "server-exits"), "137\n0\n");
      const { output, ended } = supervise(["run"], { AUTOMA_RESTART_WAIT: "0" });
      expect(await ended).toBe(0);
      expect(output.text).toContain("Automa stopped: Android ended it (signal 9)");
      expect(output.text).toContain("automa keep-alive");
      expect(await events()).toMatch(/the server stopped after \d+s with exit code 137/);
      const logs = await runFile(automa(), ["logs"]);
      expect(logs.out).toContain("Starts and stops");
      expect(logs.out).toContain("exit code 137");
    }, 60_000);

    it("notices when the last Automa was ended without warning", async () => {
      await installAutoma();
      // Android ended Termux: the launcher had no chance to remove its marker.
      const gone = spawn("true");
      await new Promise((resolve) => gone.on("exit", resolve));
      await writeFile(path.join(root, "home", ".automa", "automa.running"), `${gone.pid}\n`);
      await writeFile(pidFile(), `${gone.pid}\n`);
      const ran = await runFile(automa(), ["run"]);
      expect(ran.code, ran.out).toBe(0);
      expect(ran.out).toContain("The last Automa was ended without warning");
      expect(await events()).toContain("the last Automa was ended without warning");
      // A clean stop leaves nothing to report next time.
      await expect(stat(path.join(root, "home", ".automa", "automa.running"))).rejects.toThrow();
      const again = await runFile(automa(), ["run"]);
      expect(again.out).not.toContain("ended without warning");
    }, 60_000);

    it("never calls the first install's server, or one stopped with automa stop, ended without warning", async () => {
      await installAutoma();
      // The first install's server (automa onboard) leaves its pid file behind when it ends.
      await runFile(automa(), ["onboard", "--yes"]);
      expect((await readFile(pidFile(), "utf8")).trim()).toMatch(/^\d+$/);
      const first = await runFile(automa(), ["run"]);
      expect(first.out).not.toContain("ended without warning");

      await writeFile(path.join(root, "server-blocks"), "");
      const running = supervise(["run"]);
      // Onboard and the first run each started the server once; this is the third.
      await vi.waitFor(async () => expect(await serverStarts()).toHaveLength(3), { timeout: 20_000, interval: 100 });
      const stop = await runFile(automa(), ["stop"]);
      expect(stop.out).toContain("Automa stopped.");
      expect(await running.ended).toBe(0);
      await rm(path.join(root, "server-blocks"));
      const after = await runFile(automa(), ["run"]);
      expect(after.out).not.toContain("ended without warning");
      expect(await events()).not.toContain("without warning");
    }, 60_000);

    it("starts PostgreSQL with the settings for a phone, gives one started without them those settings, and hands the server a small pool", async () => {
      await installAutoma();
      const installStarts = (await calls()).split("\n").filter((line) => line.startsWith("pg_ctl") && line.includes(" start"));
      // The fake database reports running, so the installer had nothing to start.
      expect(installStarts).toHaveLength(0);

      await writeFile(path.join(root, "pg-down"), "");
      const ran = await runFile(automa(), ["run"]);
      expect(ran.code, ran.out).toBe(0);
      const started = (await calls()).split("\n").filter((line) => line.startsWith("pg_ctl") && / start$/.test(line));
      expect(started[0]).toContain("-o -c max_connections=30 -c shared_buffers=32MB -c max_worker_processes=2 -c max_parallel_workers=0");
      expect(started[0]).toContain("-c max_logical_replication_workers=0 -c autovacuum_max_workers=1");
      expect((await serverStarts())[0]).toContain("pool=6 idle=60");

      // An older Automa started it with PostgreSQL's own settings: restarted with the phone's.
      await writeFile(path.join(root, "pg-untuned"), "");
      const tuned = await runFile(automa(), ["run"]);
      expect(tuned.out).toContain("Restarting the database with the settings for a phone");
      expect((await calls()).split("\n").some((line) => line.startsWith("pg_ctl") && line.includes("-m fast -o -c max_connections=30") && line.endsWith(" restart"))).toBe(true);
    }, 60_000);

    it("on PostgreSQL 18, starts it without its three io workers, and gives one started with them the setting", async () => {
      await installAutoma({ pgMajor: 18 });
      const optsLine = (await readFile(automa(), "utf8")).split("\n").find((line) => line.startsWith("pg_phone_opts="));
      expect(optsLine).toContain("-c autovacuum_max_workers=1 -c io_method=sync");

      await writeFile(path.join(root, "pg-down"), "");
      const ran = await runFile(automa(), ["run"]);
      expect(ran.code, ran.out).toBe(0);
      const started = (await calls()).split("\n").filter((line) => line.startsWith("pg_ctl") && / start$/.test(line));
      expect(started[0]).toContain("-c io_method=sync");

      // Already running with them (started by Automa 1.9.12, whose settings
      // did not have it): restarted with the phone's settings.
      await writeFile(path.join(root, "pg-io-method"), "worker\n");
      const tuned = await runFile(automa(), ["run"]);
      expect(tuned.out).toContain("Restarting the database with the settings for a phone");
      expect((await calls()).split("\n").some((line) => line.startsWith("pg_ctl") && line.includes("-c io_method=sync") && line.endsWith(" restart"))).toBe(true);

      // Running with the setting already: left alone.
      await writeFile(path.join(root, "pg-io-method"), "sync\n");
      await writeFile(path.join(root, "calls.log"), "");
      const settled = await runFile(automa(), ["run"]);
      expect(settled.out).not.toContain("Restarting the database");
      expect(await calls()).not.toMatch(/pg_ctl .* restart/);
    }, 60_000);

    it("never gives PostgreSQL 17 the io_method setting, which it would refuse", async () => {
      await installAutoma({ pgMajor: 17 });
      const optsLine = (await readFile(automa(), "utf8")).split("\n").find((line) => line.startsWith("pg_phone_opts="));
      expect(optsLine).toContain("-c autovacuum_max_workers=1");
      expect(optsLine).not.toContain("io_method");
      await writeFile(path.join(root, "pg-down"), "");
      const ran = await runFile(automa(), ["run"]);
      expect(ran.code, ran.out).toBe(0);
      const pgCtl = (await calls()).split("\n").filter((line) => line.startsWith("pg_ctl"));
      expect(pgCtl.some((line) => / start$/.test(line))).toBe(true);
      expect(pgCtl.filter((line) => line.includes("io_method"))).toEqual([]);
    }, 60_000);

    it("starts the database with its own settings when it refuses the phone ones", async () => {
      await installAutoma();
      await writeFile(path.join(root, "pg-down"), "");
      // Fails once (the phone settings), then starts plainly.
      await fake("pg_ctl", [
        `[ "$1" = --version ] && { echo "pg_ctl (PostgreSQL) 17.6"; exit 0; }`,
        `case " $* " in *" status "*) [ -f "${root}/pg-down" ] && exit 3; exit 0;; esac`,
        `echo "pg_ctl $*" >> "${root}/calls.log"`,
        `case " $* " in *" -o "*) exit 1;; esac`,
        `rm -f "${root}/pg-down"; exit 0`,
      ].join("\n"));
      const ran = await runFile(automa(), ["run"]);
      expect(ran.code, ran.out).toBe(0);
      expect(ran.out).toContain("The database did not start with the settings for a phone; starting it with its own.");
      expect(await serverStarts()).toHaveLength(1);
    }, 60_000);

    it("automa restart stops the running Automa, waits for it, and starts it again in the background", async () => {
      await installAutoma();
      await writeFile(path.join(root, "server-blocks"), "");
      const first = supervise(["run"]);
      await vi.waitFor(async () => expect(await serverStarts()).toHaveLength(1), { timeout: 20_000, interval: 100 });
      await vi.waitFor(async () => expect((await readFile(pidFile(), "utf8")).trim()).toBe(String(first.child.pid)), { timeout: 10_000, interval: 100 });

      const restarted = await runFile(automa(), ["restart", "--safe"]);
      expect(restarted.code, restarted.out).toBe(0);
      expect(restarted.out).toContain("Stopping Automa...");
      expect(restarted.out).toContain("Automa is starting in safe mode");
      expect(await first.ended).toBe(0);
      await vi.waitFor(async () => expect(await serverStarts()).toHaveLength(2), { timeout: 20_000, interval: 100 });
      expect((await serverStarts())[1]).toContain("safe=1 reason=asked");
      // The new one is the one on record, so automa stop reaches it.
      const newPid = Number((await readFile(pidFile(), "utf8")).trim());
      expect(newPid).not.toBe(first.child.pid);
      expect(alive(newPid)).toBe(true);
      const stop = await runFile(automa(), ["stop"]);
      expect(stop.out).toContain("Automa stopped.");
      await vi.waitFor(() => expect(alive(newPid)).toBe(false), { timeout: 20_000, interval: 100 });
    }, 90_000);

    describe("automa troubleshoot", () => {
      const automaHome = () => path.join(root, "home", ".automa");
      /** A phone with `sdkInt`, `availableKb` of storage and plenty of memory. */
      async function phone({ sdkInt = 34, availableKb = 50_000_000 } = {}) {
        await fake("getprop", `case "$1" in ro.build.version.sdk) echo ${sdkInt};; ro.build.version.release) echo ${sdkInt - 20};; esac`);
        await fake("df", `echo "Filesystem 1024-blocks Used Available Capacity Mounted"; echo "/dev/data 120000000 1000 $(cat "${root}/df-available" 2>/dev/null || echo ${availableKb}) 1% /data"`);
        await writeFile(path.join(root, "meminfo"), "MemTotal: 8000000 kB\nMemAvailable: 3000000 kB\n");
        await fake("am", `echo "am $*" >> "${root}/calls.log"`);
      }
      const troubleshoot = (args: string[] = [], env: Record<string, string> = {}) =>
        runFile(automa(), ["troubleshoot", ...args], { env: { AUTOMA_MEMINFO: path.join(root, "meminfo"), ...env } });
      /** A health endpoint that first refuses (nothing running), then answers with `body`. */
      async function healthAfterRefusal(body: unknown) {
        const http = await import("node:http");
        let calls = 0;
        health = http.createServer((req, res) => {
          calls += 1;
          if (calls === 1) {
            req.socket.destroy();
            return;
          }
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(body));
        });
        await new Promise<void>((resolve) => health!.listen(0, "127.0.0.1", () => resolve()));
        return `http://127.0.0.1:${(health.address() as { port: number }).port}/api/health`;
      }

      it("repairs what Automa left behind: the database lock, an update cut short, a stopped database", async () => {
        await installAutoma();
        await phone();
        await writeFile(path.join(automaHome(), "keep-alive"), "android=14 sdk=34\n");
        // Android ended Termux: PostgreSQL's lock names a process that is gone,
        // and the update stopped between taking the old server away and putting the new one in.
        const gone = spawn("true");
        await new Promise((resolve) => gone.on("exit", resolve));
        await writeFile(path.join(root, "pgdata", "postmaster.pid"), `${gone.pid}\n`);
        await writeFile(path.join(root, "pg-down"), "");
        const server = path.join(automaHome(), "server");
        await rm(`${server}.next`, { recursive: true, force: true });
        await (await import("node:fs/promises")).rename(server, `${server}.next`);
        const url = await healthAnswers([{ status: "ok" }]);

        const result = await troubleshoot([], { AUTOMA_HEALTH_URL: url });

        expect(result.out).toContain("Fixed: Cleared PostgreSQL's lock file from before");
        expect(result.out).toContain("Fixed: An update stopped just before it finished; Automa 9.9.9 is now in place.");
        expect(result.out).toContain("Fixed: The database wasn't running; it is now.");
        expect(result.out).toContain("Automa is running and ready");
        expect(result.out).toContain("lifted (automa keep-alive)");
        expect(result.out).toContain("No problems found. Fixed 3 thing(s) along the way.");
        expect(result.code, result.out).toBe(0);
        await expect(readFile(path.join(server, "node_modules", "paperclipai", "dist", "index.js"), "utf8")).resolves.toBe("");
        await expect(stat(`${server}.next`)).rejects.toThrow();
        await expect(stat(path.join(root, "pgdata", "postmaster.pid"))).rejects.toThrow();
        expect(await calls()).toMatch(/pg_ctl -D \S+ -l \S+ -o -c max_connections=30 .* -w start/);
      }, 60_000);

      it("says when Android ended Automa, and how to stop it", async () => {
        await installAutoma();
        await phone({ sdkInt: 34 });
        await writeFile(
          path.join(automaHome(), "events.log"),
          [
            "2026-11-16 20:00:00 started",
            "2026-11-16 20:41:10 the server stopped after 2470s with exit code 137",
            "2026-11-16 20:41:13 the last Automa was ended without warning (Android closed Termux, signal 9)",
          ].join("\n") + "\n",
        );
        const result = await troubleshoot([], { AUTOMA_HEALTH_URL: "http://127.0.0.1:9/api/health" });
        expect(result.code).toBe(1);
        expect(result.out).toContain("Android ended Automa without warning 2 time(s) recently");
        expect(result.out).toContain("Android 14 ends Termux's processes when apps together run too many");
        expect(result.out).toContain("Run: automa keep-alive");
        expect(result.out).toContain("Settings → Developer options → Disable child process restrictions");
        expect(result.out).toContain("exit code 137");
      }, 60_000);

      it("says when Node.js is older than the 24.11 the server needs, and how to upgrade it", async () => {
        await installAutoma();
        await writeFile(path.join(root, "node-version"), "24.10.0\n");
        const old = await troubleshoot([], { AUTOMA_HEALTH_URL: "http://127.0.0.1:9/api/health" });
        expect(old.out).toContain("Automa needs Node.js 24.11 or newer (this Termux has v24.10.0).");
        expect(old.out).toContain("Run: pkg upgrade -y");
        await writeFile(path.join(root, "node-version"), "24.11.0\n");
        const current = await troubleshoot([], { AUTOMA_HEALTH_URL: "http://127.0.0.1:9/api/health" });
        expect(current.out).toContain("✓ Node.js v24.11.0");
        expect(current.out).not.toContain("Automa needs Node.js");
      }, 60_000);

      it("reads the logs before freeing space, and never touches backups", async () => {
        await installAutoma();
        await phone({ availableKb: 100_000 });
        await writeFile(path.join(automaHome(), "server.log.1"), "<--- Last few GCs --->\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n");
        const backup = await writeBackup("automa-hourly-20261116-200000.sql.gz", COMPLETE_DUMP, 60);
        const result = await troubleshoot([], { AUTOMA_HEALTH_URL: "http://127.0.0.1:9/api/health" });
        expect(result.out).toContain("Only 97 MB of storage is free.");
        expect(result.out).toContain("Fixed: Removed the previous start's log.");
        expect(result.out).toContain("The log says: Automa ran out of memory.");
        expect(result.out).toContain("Newest backup: automa-hourly-20261116-200000.sql.gz");
        expect(result.code).toBe(1);
        await expect(stat(backup)).resolves.toBeTruthy();
      }, 60_000);

      it("clears npm's unfinished downloads and the package files Termux downloaded when storage is nearly gone", async () => {
        await installAutoma();
        await phone({ availableKb: 100_000 });
        await mkdir(path.join(root, "home", ".npm", "_cacache", "tmp"), { recursive: true });
        await writeFile(path.join(root, "home", ".npm", "_cacache", "tmp", "half-download"), Buffer.alloc(3 * 1024 * 1024));
        await fake("apt-get", `echo "apt-get $*" >> "${root}/calls.log"; [ "$1" = clean ] && echo 612000 > "${root}/df-available"; exit 0`);
        const result = await troubleshoot([], { AUTOMA_HEALTH_URL: "http://127.0.0.1:9/api/health", AUTOMA_UPDATE_HEADROOM_MB: "300" });
        expect(result.out).toContain("Only 97 MB of storage is free.");
        expect(result.out).toMatch(/Fixed: Removed npm's unfinished downloads and logs in .*_cacache\/tmp \(\d MB\)\./);
        expect(result.out).toContain("Fixed: Removed the package files Termux had downloaded (500 MB; what is installed stays).");
        // With what an update needs, measured like the installer measures it: the size of the server (a few files here) and 300 MB to work in.
        expect(result.out).toMatch(/Now 597 MB free \(an update needs about 30\d MB\)\./);
        expect(await calls()).toContain("apt-get clean");
        await expect(stat(path.join(root, "home", ".npm", "_cacache", "tmp"))).rejects.toThrow();
      }, 60_000);

      it("says when the room left is not enough for an update, with what an update needs", async () => {
        await installAutoma();
        await phone({ availableKb: 400_000 });
        const short = await troubleshoot([], { AUTOMA_HEALTH_URL: "http://127.0.0.1:9/api/health", AUTOMA_UPDATE_HEADROOM_MB: "800" });
        expect(short.out).toMatch(/390 MB of storage free: not enough for an update, which needs about 80\d MB \(the new server is prepared next to the one in use\)\./);
        // Nothing is cleared for it: that is for a phone that is nearly out of room.
        expect(short.out).not.toContain("Fixed: Emptied npm's download cache");
        // Enough for an update, but not much more.
        const low = await troubleshoot([], { AUTOMA_HEALTH_URL: "http://127.0.0.1:9/api/health", AUTOMA_UPDATE_HEADROOM_MB: "300" });
        expect(low.out).toContain("390 MB of storage free: getting low.");
        expect(low.out).not.toContain("not enough for an update");
      }, 60_000);

      it("changes nothing about a database another PostgreSQL version wrote, and says how to keep it", async () => {
        await installAutoma();
        await phone();
        await writeFile(path.join(root, "pgdata", "PG_VERSION"), "16\n");
        await writeFile(path.join(root, "pg-down"), "");
        const result = await troubleshoot([], { AUTOMA_HEALTH_URL: "http://127.0.0.1:9/api/health" });
        expect(result.code).toBe(1);
        expect(result.out).toContain("The database was written by PostgreSQL 16, but Termux now has PostgreSQL 17");
        expect(result.out).toContain("pkg install postgresql=16*");
        expect(await calls()).not.toMatch(/pg_ctl .* start/);
      }, 60_000);

      it("says a refused database update is applied by starting Automa, and only a failed one needs a backup", async () => {
        await installAutoma();
        await phone();
        // What the first start after an update printed when it was asked on a terminal and the answer was No.
        await writeFile(
          path.join(automaHome(), "server.log.1"),
          "Paperclip server failed to start.\nPostgreSQL has pending migrations (0291_reflective_loners.sql). Refusing to start against a stale schema. Run pnpm db:migrate or set PAPERCLIP_MIGRATION_AUTO_APPLY=true.\n",
        );
        const refused = await troubleshoot(["--start", "--no-follow"], { AUTOMA_HEALTH_URL: "http://127.0.0.1:9/api/health" });
        expect(refused.out).toContain("The log says: the new version's database changes were not applied yet, so Automa did not start.");
        expect(refused.out).toContain(`Starting Automa applies them; the copy of the database from before the update is in ${backups()}. Run: automa run\n`);
        expect(refused.out).not.toContain("automa restore lists backups");
        expect(refused.out).not.toContain("updating the database to this version failed");
        // The start it makes (automa fix --start) applies them too.
        await vi.waitFor(async () => expect((await calls()).split("\n").filter((line) => line.startsWith("server "))).toHaveLength(1), {
          timeout: 20_000,
          interval: 100,
        });
        expect((await calls()).split("\n").find((line) => line.startsWith("server "))).toMatch(/ migrate=true$/);

        // A migration that ran and failed: the copy from before the update is the way back.
        await writeFile(
          path.join(automaHome(), "server.log.1"),
          "Paperclip server failed to start.\nFailed to apply pending migrations: 0291_reflective_loners.sql\n",
        );
        const failed = await troubleshoot([], { AUTOMA_HEALTH_URL: "http://127.0.0.1:9/api/health" });
        expect(failed.out).toContain("The log says: updating the database to this version failed.");
        expect(failed.out).toContain("automa restore lists backups; the one named automa-before-<version> is from just before the update.");
        expect(failed.out).not.toContain("database changes were not applied yet");
      }, 60_000);

      it("--start starts Automa in safe mode when it had fallen back to it, and follows it until it is ready", async () => {
        await installAutoma();
        await phone();
        await writeFile(
          path.join(automaHome(), "events.log"),
          ["2026-11-16 20:00:00 started", "2026-11-16 20:00:40 falling back to safe mode after 3 quick stops"].join("\n") + "\n",
        );
        const url = await healthAfterRefusal({ status: "ok", safeMode: true, safeModeReason: "asked" });
        const result = await troubleshoot(["--start"], { AUTOMA_HEALTH_URL: url, AUTOMA_FOLLOW_POLL_MS: "20" });
        expect(result.out).toContain("Automa kept stopping while it started, so it starts in safe mode.");
        expect(result.out).toContain("Automa is starting in safe mode");
        expect(result.out).toContain("It is in safe mode");
        expect(result.out).toContain("Switch back to the Automa app");
        expect(await calls()).toContain("am start -n com.corxlabs.automa/.MainActivity");
        await vi.waitFor(async () => expect((await calls()).split("\n").filter((line) => line.startsWith("server "))[0]).toContain("safe=1 reason=asked"), {
          timeout: 20_000,
          interval: 100,
        });
      }, 60_000);

      it("--start --no-follow (the app's Troubleshoot button) starts Automa and leaves the waiting to the app", async () => {
        await installAutoma();
        await phone();
        const result = await troubleshoot(["--start", "--no-follow"], { AUTOMA_HEALTH_URL: "http://127.0.0.1:9/api/health" });
        expect(result.out).toContain("Automa is starting (log:");
        expect(result.out).not.toContain("Switch back to the Automa app");
        expect(await calls()).not.toContain("am start");
        await vi.waitFor(async () => expect((await calls()).split("\n").filter((line) => line.startsWith("server "))).toHaveLength(1), {
          timeout: 20_000,
          interval: 100,
        });
      }, 60_000);

      it("--start starts Automa normally when it was not in a crash loop", async () => {
        await installAutoma();
        await phone();
        await writeFile(path.join(automaHome(), "events.log"), ["2026-11-16 20:00:40 falling back to safe mode after 3 quick stops", "2026-11-16 20:05:00 restarting normally, as asked on the board"].join("\n") + "\n");
        const url = await healthAfterRefusal({ status: "ok" });
        const result = await troubleshoot(["--start"], { AUTOMA_HEALTH_URL: url, AUTOMA_FOLLOW_POLL_MS: "20" });
        expect(result.out).not.toContain("starts in safe mode");
        expect(result.out).toContain("Automa is starting (log:");
        await vi.waitFor(async () => expect((await calls()).split("\n").filter((line) => line.startsWith("server "))[0]).toContain("safe= reason="), {
          timeout: 20_000,
          interval: 100,
        });
      }, 60_000);
    });

    describe("automa keep-alive", () => {
      const marker = () => path.join(root, "home", ".automa", "keep-alive");
      async function phone(sdkInt: number, { linked = true, settingIgnored = false } = {}) {
        await fake("getprop", `case "$1" in ro.build.version.sdk) echo ${sdkInt};; ro.build.version.release) echo ${sdkInt - 20};; esac`);
        if (linked) await writeFile(path.join(root, "adb-linked"), "");
        if (settingIgnored) await writeFile(path.join(root, "setting-ignored"), "");
        await fake("adb", [
          `echo "adb $*" >> "${root}/calls.log"`,
          `if [ "$1" = devices ]; then echo "List of devices attached"; [ -f "${root}/adb-linked" ] && printf '127.0.0.1:37123\\tdevice\\n'; exit 0; fi`,
          `[ "$1" = -s ] && shift 2`,
          `[ "$1" = shell ] && shift`,
          `case "$*" in`,
          `  "settings put global settings_enable_monitor_phantom_procs false") [ -f "${root}/setting-ignored" ] || touch "${root}/phantom-off";;`,
          `  "settings get global settings_enable_monitor_phantom_procs") if [ -f "${root}/phantom-off" ]; then echo false; else echo null; fi;;`,
          `  "/system/bin/device_config put activity_manager max_phantom_processes 2147483647") touch "${root}/max-phantom";;`,
          `  "/system/bin/device_config get activity_manager max_phantom_processes") if [ -f "${root}/max-phantom" ]; then echo 2147483647; else echo null; fi;;`,
          `  "dumpsys deviceidle whitelist +com.termux") touch "${root}/termux-allowed"; echo "Added: com.termux";;`,
          `  "dumpsys deviceidle whitelist") echo "system-excidle,com.android.shell,2000"; [ -f "${root}/termux-allowed" ] && echo "user,com.termux,10234";;`,
          `esac`,
          `exit 0`,
        ].join("\n"));
      }
      const adbCalls = async () => (await calls()).split("\n").filter((line) => line.startsWith("adb "));

      it("lifts Android 12L-and-newer's process limit and battery optimisation for Termux, checks both, and remembers it", async () => {
        await installAutoma();
        await phone(34);
        const before = await runFile(automa(), ["keep-alive", "--check"]);
        expect(before.code).toBe(1);
        expect(before.out).toContain("Not done yet on this phone");

        const result = await runFile(automa(), ["keep-alive"]);
        expect(result.code, result.out).toBe(0);
        expect(result.out).toContain("Android no longer ends Termux for running too many processes");
        expect(result.out).toContain("Battery optimisation is off for Termux");
        const sent = await adbCalls();
        expect(sent).toContain("adb -s 127.0.0.1:37123 shell settings put global settings_enable_monitor_phantom_procs false");
        expect(sent).toContain("adb -s 127.0.0.1:37123 shell dumpsys deviceidle whitelist +com.termux");
        expect(sent).toContain("adb -s 127.0.0.1:37123 shell cmd appops set com.termux RUN_ANY_IN_BACKGROUND allow");
        // 12L and newer have the switch: Google's flag sync is left alone.
        expect(sent.join("\n")).not.toContain("set_sync_disabled_for_tests");
        expect(await readFile(marker(), "utf8")).toContain("process_limit=settings_enable_monitor_phantom_procs=false");

        const after = await runFile(automa(), ["keep-alive", "--check"]);
        expect(after.code).toBe(0);
        expect(after.out).toContain("Done before:");
      }, 60_000);

      it("uses device_config on Android 12, which has no switch", async () => {
        await installAutoma();
        await phone(31);
        const result = await runFile(automa(), ["keep-alive"]);
        expect(result.code, result.out).toBe(0);
        const sent = (await adbCalls()).join("\n");
        expect(sent).toContain("shell /system/bin/device_config set_sync_disabled_for_tests persistent");
        expect(sent).toContain("shell /system/bin/device_config put activity_manager max_phantom_processes 2147483647");
        expect(sent).not.toContain("settings put global");
        expect(await readFile(marker(), "utf8")).toContain("process_limit=max_phantom_processes=2147483647");
      }, 60_000);

      it("falls back to device_config when Android ignores the switch", async () => {
        await installAutoma();
        await phone(33, { settingIgnored: true });
        const result = await runFile(automa(), ["keep-alive"]);
        expect(result.code, result.out).toBe(0);
        expect(result.out).toContain("(through device_config)");
        expect(await readFile(marker(), "utf8")).toContain("process_limit=max_phantom_processes=2147483647");
      }, 60_000);

      it("changes nothing and says what to do when Wireless debugging isn't linked and there is no terminal to link it", async () => {
        await installAutoma();
        await phone(34, { linked: false });
        const result = await runFile(automa(), ["keep-alive"], { command: ["setsid", "-w", "timeout", "-s", "KILL", "20", "bash"] });
        expect(result.code).toBe(1);
        expect(result.out).toContain("Wireless debugging is not linked, so nothing changed.");
        expect(result.out).toContain("Settings → Developer options → Disable child process restrictions");
        await expect(stat(marker())).rejects.toThrow();
        expect((await adbCalls()).join("\n")).not.toContain("shell settings put");
      }, 60_000);
    });
  });
});
