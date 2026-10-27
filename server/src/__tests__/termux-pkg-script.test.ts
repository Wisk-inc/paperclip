import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPTS = fileURLToPath(new URL("../services/scripts/", import.meta.url));

/**
 * A fake Termux: `pkg` ends the way it does when Android clears apt's cache
 * mid-download, and `apt-get` only installs into a download folder whose
 * partial/ exists, like the real one.
 */
let root = "";
let prefix = "";
let bin = "";
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "termux-pkg-"));
  prefix = path.join(root, "com.termux", "files", "usr");
  bin = path.join(root, "fakebin");
  await mkdir(bin, { recursive: true });
  await mkdir(path.join(prefix, "bin"), { recursive: true });
  const fake = async (name: string, body: string) => {
    await writeFile(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    await chmod(path.join(bin, name), 0o755);
  };
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
  await rm(root, { recursive: true, force: true });
});

function run(script: string, args: string[]) {
  return new Promise<{ code: number; out: string }>((resolve) => {
    execFile("bash", [path.join(SCRIPTS, script), ...args], {
      env: { ...process.env, PREFIX: prefix, HOME: path.join(root, "home"), PATH: `${bin}:${prefix}/bin:/usr/bin:/bin`, AUTOMA_PKG_RETRY_WAIT: "0" },
      cwd: root,
    }, (error, stdout, stderr) => resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}` }));
  });
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
    await writeFile(path.join(bin, "java"), `#!/usr/bin/env bash\necho "java $*"\n`);
    await chmod(path.join(bin, "java"), 0o755);
    await writeFile(path.join(bin, "curl"), [
      "#!/usr/bin/env bash",
      `case "$*" in`,
      `  *api.github.com*) echo '{"assets":[{"name":"apktool_3.0.3.jar","browser_download_url": "https://github.com/iBotPeaches/Apktool/releases/download/v3.0.3/apktool_3.0.3.jar"}]}';;`,
      `  *) out=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done; echo jar > "$out";;`,
      "esac",
    ].join("\n"));
    await chmod(path.join(bin, "curl"), 0o755);
    const result = await run("app-inspector/app-inspector.sh", ["decode", path.join(root, "app.apk"), path.join(root, "out")]);
    expect(result.out).toContain("Downloading apktool from its GitHub release instead");
    expect(result.out).toContain(`java -jar ${path.join(root, "home", ".automa", "tools", "apktool.jar")} d -f`);
    expect(result.code).toBe(0);
  });
});
