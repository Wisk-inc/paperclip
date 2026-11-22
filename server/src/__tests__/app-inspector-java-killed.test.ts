import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ root: "" }));
vi.mock("../home-paths.js", () => ({ resolvePaperclipInstanceRoot: () => state.root }));

import { __resetInspector, getInspectorProject, inspectorProjectView, startDecode } from "../services/app-inspector/inspector.js";

const SCRIPT = fileURLToPath(new URL("../services/scripts/app-inspector/app-inspector.sh", import.meta.url));
const COMPANY = "company-1";

/** Reads `-d <out>` (jadx) or `-o <out>` (apktool) from the arguments, as the real tools do. */
const OUT_ARGUMENT = 'out=""\nwhile [ $# -gt 0 ]; do case "$1" in -d|-o) out="$2"; shift;; esac; shift; done\n';
/** A jadx that writes one class and then ends the way `ending` says. */
const fakeJadx = (ending: string) =>
  `#!/usr/bin/env bash\n${OUT_ARGUMENT}mkdir -p "$out/sources/com/example"\necho "class Main {}" > "$out/sources/com/example/Main.java"\n${ending}\n`;
const KILLED = "kill -9 $$";
const SOME_ERRORS = "exit 1";
const FAKE_APKTOOL = `#!/usr/bin/env bash\n${OUT_ARGUMENT}mkdir -p "$out"\necho '<manifest package="com.example"/>' > "$out/AndroidManifest.xml"\n`;

describe.skipIf(process.platform === "win32")("App Inspector: jadx stopped before it finished", () => {
  const savedPath = process.env.PATH;
  const savedHome = process.env.HOME;
  const savedPrefix = process.env.PREFIX;
  let tools: string;
  let apk: string;

  function tool(name: string, script: string) {
    writeFileSync(path.join(tools, name), script);
    chmodSync(path.join(tools, name), 0o755);
  }

  function runJava(out: string) {
    return spawnSync("bash", [SCRIPT, "java", apk, out], { encoding: "utf8", env: { ...process.env } });
  }

  beforeEach(() => {
    state.root = mkdtempSync(path.join(os.tmpdir(), "automa-inspector-jadx-"));
    __resetInspector();
    tools = path.join(state.root, "tools");
    mkdirSync(tools, { recursive: true });
    tool("apktool", FAKE_APKTOOL);
    tool("java", "#!/usr/bin/env bash\nexit 0\n");
    apk = path.join(state.root, "app.apk");
    writeFileSync(apk, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]));
    process.env.PATH = `${tools}${path.delimiter}${savedPath ?? ""}`;
    process.env.HOME = path.join(state.root, "home");
    delete process.env.PREFIX;
  });
  afterEach(() => {
    __resetInspector();
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedPrefix !== undefined) process.env.PREFIX = savedPrefix;
    rmSync(state.root, { recursive: true, force: true });
  });

  it("the script is valid bash", () => {
    expect(spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" })).toMatchObject({ status: 0, stderr: "" });
  });

  it("the script fails and says why when jadx is killed part-way", () => {
    tool("jadx", fakeJadx(KILLED));
    const out = path.join(state.root, "java out");
    const run = runJava(out);
    // jadx had already written a class when it was killed.
    expect(existsSync(path.join(out, "sources", "com", "example", "Main.java"))).toBe(true);
    expect(run.status).toBe(4);
    expect(run.stderr).toContain("jadx was stopped before it finished");
    expect(run.stderr).toContain("ran out of memory");
    expect(run.stdout).not.toContain("Java is ready to read.");
    expect(run.stdout).not.toContain("finished with some errors");
  });

  it("the script still accepts a jadx that could not decompile a few methods", () => {
    tool("jadx", fakeJadx(SOME_ERRORS));
    const run = runJava(path.join(state.root, "java out"));
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("jadx finished with some errors; most of the code is still readable.");
    expect(run.stdout).toContain("Java is ready to read.");
  });

  async function decodeAndWait() {
    const started = await startDecode({ companyId: COMPANY, label: "Example", apkPath: apk });
    let view = started;
    await vi.waitFor(() => {
      view = inspectorProjectView(getInspectorProject(COMPANY, started.id)!);
      expect(view.status).not.toBe("decoding");
      expect(view.java).not.toBe("working");
    }, { timeout: 20_000, interval: 50 });
    return view;
  }

  it("the project's Java is failed, not ready, when jadx is killed part-way", async () => {
    tool("jadx", fakeJadx(KILLED));
    const project = await decodeAndWait();
    expect(project).toMatchObject({ status: "ready", decoded: true, java: "failed" });
    expect(project.logTail).toContain("jadx was stopped before it finished");
  }, 30_000);

  it("the project's Java is ready when jadx only had some errors", async () => {
    tool("jadx", fakeJadx(SOME_ERRORS));
    const project = await decodeAndWait();
    expect(project).toMatchObject({ status: "ready", decoded: true, java: "ready" });
  }, 30_000);
});
