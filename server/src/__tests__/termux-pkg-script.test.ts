import { execFile, spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
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

describe("automa-adb-link.sh", () => {
  it("stops with a clear reason when there is no terminal to type the numbers in", async () => {
    await fake("adb", `case "$1" in devices) echo "List of devices attached";; esac; exit 0`);
    // setsid: no controlling terminal, as when an agent or the app runs it.
    const result = await runFile(path.join(MOBILE_TERMUX, "automa-adb-link.sh"), [], { command: ["setsid", "-w", "timeout", "-s", "KILL", "20", "bash"] });
    expect(result.code).toBe(1);
    expect(result.out).toContain("run it in the Termux app");
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
  async function installAutoma({ nodeMissing = false } = {}) {
    const bundle = path.join(root, "bundle");
    await mkdir(path.join(bundle, "packages", "server", "package"), { recursive: true });
    await writeFile(path.join(bundle, "packages", "server", "package", "package.json"), "{}\n");
    await writeFile(path.join(bundle, "VERSION"), "9.9.9\n");
    for (const name of ["install.sh", "automa-adb-link.sh"]) await copyFile(path.join(MOBILE_TERMUX, name), path.join(bundle, name));
    await mkdir(path.join(root, "pgdata"), { recursive: true });
    await mkdir(path.join(root, "tmp"), { recursive: true });
    await writeFile(path.join(root, "pgdata", "PG_VERSION"), "17\n");
    await writeFile(path.join(root, "pgdata", "pg_hba.conf"), "host all all 127.0.0.1/32 scram-sha-256\n");
    await writeFile(path.join(root, "pkg-works"), "");
    await symlink("/bin/bash", path.join(prefix, "bin", "bash"));
    // Without Node, pkg installs it (the stand-in) when asked for nodejs-lts.
    await fake("node", `case "$*" in *process.versions*) echo 24;; *process.platform*) echo linux;; *) [ -f "${root}/server-up" ];; esac`, nodeMissing ? path.join(root, "pkg-files") : bin);
    if (nodeMissing) await fake("pkg", `echo "pkg $*" >> "${root}/calls.log"; case " $* " in *" nodejs-lts "*) cp "${root}/pkg-files/node" "${prefix}/bin/node";; esac`);
    await fake("pg_ctl", `[ "$1" = --version ] && echo "pg_ctl (PostgreSQL) 17.6"; exit 0`);
    await fake("psql", `echo "psql $*" >> "${root}/calls.log"; case "$*" in *--quiet*) cat > "${root}/restored.sql";; *) echo 1;; esac`);
    await fake("createdb", `echo "createdb $*" >> "${root}/calls.log"`);
    await fake("dropdb", `echo "dropdb $*" >> "${root}/calls.log"`);
    await fake("pg_dump", [
      `echo "pg_dump $*" >> "${root}/calls.log"`,
      `echo "-- PostgreSQL database dump"; echo "CREATE TABLE companies (id uuid);"`,
      `[ -f "${root}/pg_dump-fails" ] && { echo "pg_dump: error: could not write to output file: No space left on device" >&2; exit 1; }`,
      `echo "--"; echo "-- PostgreSQL database dump complete"; echo "--"`,
    ].join("\n"));
    await fake("npm", `while [ $# -gt 0 ]; do [ "$1" = --prefix ] && dir="$2"; shift; done; mkdir -p "$dir/node_modules/paperclipai/dist"; touch "$dir/node_modules/paperclipai/dist/index.js"`);
    const installed = await runFile(path.join(bundle, "install.sh"), [], { env: { AUTOMA_INSTALL_NO_START: "1" } });
    expect(installed.out).toContain("Installed.");
    expect(installed.code).toBe(0);
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

  it("automa link opens the app with a MAIN intent and the app key", async () => {
    await installAutoma();
    await fake("am", `echo "am $*" >> "${root}/calls.log"`);
    const result = await runFile(automa(), ["link"]);
    expect(result.code).toBe(0);
    expect(await calls()).toMatch(/am start -a android\.intent\.action\.MAIN -n com\.corxlabs\.automa\/\.MainActivity --es com\.corxlabs\.automa\.CONNECT http:\/\/127\.0\.0\.1:3100 --es com\.corxlabs\.automa\.SECRET [0-9a-f]{48}\n/);
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

  it("automa restore waits for an Automa started elsewhere to be stopped", async () => {
    await installAutoma();
    const good = await writeBackup("automa-manual-20261002-000000.sql.gz", COMPLETE_DUMP, 5);
    await writeFile(path.join(root, "server-up"), "");
    const result = await runFile(automa(), ["restore", good, "--yes"]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("Automa is still running");
    expect(await calls()).not.toContain("dropdb");
  }, 60_000);
});
