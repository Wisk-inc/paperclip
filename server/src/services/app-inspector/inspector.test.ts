import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const paths = vi.hoisted(() => ({ root: "" }));
vi.mock("../../home-paths.js", () => ({ resolvePaperclipInstanceRoot: () => paths.root }));

import {
  __resetInspector,
  confineToBase,
  inspectorAppInfo,
  listInspectorProjects,
  readInspectorFile,
  searchInspector,
  startDecodeFromStream,
  writeInspectorFile,
} from "./inspector.js";

const COMPANY = "company-1";

/** A project folder as an earlier server run left it. */
function seedProject(id: string, meta: Record<string, unknown>, options: { decoded?: boolean; java?: boolean } = {}) {
  const dir = path.join(paths.root, "app-inspector", id);
  mkdirSync(dir, { recursive: true });
  if (options.decoded) mkdirSync(path.join(dir, "decoded", "res", "values"), { recursive: true });
  if (options.java) mkdirSync(path.join(dir, "java", "sources", "com", "example"), { recursive: true });
  writeFileSync(
    path.join(dir, "project.json"),
    JSON.stringify({ id, companyId: COMPANY, label: "Example", createdAt: "2026-10-24T00:00:00.000Z", java: "none", ...meta }),
  );
  return dir;
}

describe("App Inspector path confinement", () => {
  const base = "/tmp/proj/decoded";
  it("keeps paths inside the decoded tree", () => {
    expect(confineToBase(base, "AndroidManifest.xml")).toBe(path.join(base, "AndroidManifest.xml"));
    expect(confineToBase(base, "res/values/strings.xml")).toBe(path.join(base, "res/values/strings.xml"));
    expect(confineToBase(base, "/leading/slash.txt")).toBe(path.join(base, "leading/slash.txt"));
    expect(confineToBase(base, "")).toBe(base);
  });
  it("refuses anything that climbs out", () => {
    expect(() => confineToBase(base, "../../etc/passwd")).toThrow(/escapes/);
    expect(() => confineToBase(base, "a/../../../root/.ssh/id_rsa")).toThrow(/escapes/);
    expect(() => confineToBase(base, "..")).toThrow(/escapes/);
  });
});

describe("App Inspector projects", () => {
  beforeEach(() => {
    paths.root = mkdtempSync(path.join(os.tmpdir(), "automa-inspector-"));
    __resetInspector();
  });
  afterEach(() => {
    __resetInspector();
    rmSync(paths.root, { recursive: true, force: true });
  });

  it("comes back after a restart, and work that was cut off says so", () => {
    seedProject("11111111-1111-4111-8111-111111111111", { status: "decoding" });
    seedProject("22222222-2222-4222-8222-222222222222", { status: "building", decoded: true }, { decoded: true });
    seedProject("33333333-3333-4333-8333-333333333333", { status: "ready", java: "working" }, { decoded: true });
    const byId = new Map(listInspectorProjects(COMPANY).map((project) => [project.id, project]));
    expect(byId.size).toBe(3);
    expect(byId.get("11111111-1111-4111-8111-111111111111")).toMatchObject({ status: "failed", decoded: false });
    expect(byId.get("22222222-2222-4222-8222-222222222222")).toMatchObject({ status: "ready", decoded: true });
    expect(byId.get("22222222-2222-4222-8222-222222222222")?.error).toMatch(/Rebuild again/);
    expect(byId.get("33333333-3333-4333-8333-333333333333")).toMatchObject({ status: "ready", java: "failed" });
    expect(listInspectorProjects("another-company")).toEqual([]);
  });

  it("never saves over a binary file or one too big to show whole", async () => {
    const id = "44444444-4444-4444-8444-444444444444";
    const dir = seedProject(id, { status: "ready" }, { decoded: true });
    writeFileSync(path.join(dir, "decoded", "res", "values", "strings.xml"), "<resources/>");
    writeFileSync(path.join(dir, "decoded", "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    writeFileSync(path.join(dir, "decoded", "huge.smali"), "a".repeat(2 * 1024 * 1024 + 10));

    expect(await readInspectorFile(COMPANY, id, "icon.png")).toMatchObject({ binary: true, readOnly: true });
    await expect(writeInspectorFile(COMPANY, id, "icon.png", "oops")).rejects.toThrow(/binary/);
    expect(readFileSync(path.join(dir, "decoded", "icon.png"))[4]).toBe(0);

    expect(await readInspectorFile(COMPANY, id, "huge.smali")).toMatchObject({ truncated: true, readOnly: true });
    await expect(writeInspectorFile(COMPANY, id, "huge.smali", "short")).rejects.toThrow(/too large/);

    await writeInspectorFile(COMPANY, id, "res/values/strings.xml", "<resources><string name=\"a\">b</string></resources>");
    expect(readFileSync(path.join(dir, "decoded", "res", "values", "strings.xml"), "utf8")).toContain("name=\"a\"");
    await expect(writeInspectorFile(COMPANY, id, "../project.json", "{}")).rejects.toThrow(/escapes/);
  });

  it("shows decompiled Java read-only", async () => {
    const id = "55555555-5555-4555-8555-555555555555";
    const dir = seedProject(id, { status: "ready", java: "ready" }, { decoded: true, java: true });
    writeFileSync(path.join(dir, "java", "sources", "com", "example", "Main.java"), "class Main {}");
    expect(await readInspectorFile(COMPANY, id, "com/example/Main.java", "java")).toMatchObject({ text: "class Main {}", readOnly: true });
  });

  it("reads the app's identity from its decoded manifest", async () => {
    const id = "77777777-7777-4777-8777-777777777777";
    const dir = seedProject(id, { status: "ready" }, { decoded: true });
    const decoded = path.join(dir, "decoded");
    writeFileSync(
      path.join(decoded, "AndroidManifest.xml"),
      `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.notes">
    <uses-permission android:name="android.permission.INTERNET"/>
    <uses-permission android:name="android.permission.CAMERA"/>
    <application android:debuggable="true" android:icon="@mipmap/ic_launcher" android:label="@string/app_name">
        <activity android:exported="true" android:name="com.example.notes.MainActivity">
            <intent-filter>
                <action android:name="android.intent.action.MAIN"/>
                <category android:name="android.intent.category.LAUNCHER"/>
            </intent-filter>
        </activity>
        <activity android:name="com.example.notes.EditActivity"/>
        <service android:name="com.example.notes.SyncService"/>
        <receiver android:name="com.example.notes.BootReceiver"/>
        <provider android:authorities="x" android:name="androidx.core.content.FileProvider"/>
    </application>
</manifest>`,
    );
    writeFileSync(path.join(decoded, "apktool.yml"), "sdkInfo:\n  minSdkVersion: 26\n  targetSdkVersion: 36\nversionInfo:\n  versionCode: 42\n  versionName: 3.2.1\n");
    writeFileSync(path.join(decoded, "res", "values", "strings.xml"), '<resources><string name="app_name">Notes</string></resources>');
    mkdirSync(path.join(decoded, "res", "mipmap-xxhdpi"), { recursive: true });
    writeFileSync(path.join(decoded, "res", "mipmap-xxhdpi", "ic_launcher.png"), Buffer.from([0x89, 0x50]));
    expect(await inspectorAppInfo(COMPANY, id)).toEqual({
      packageName: "com.example.notes",
      label: "Notes",
      versionName: "3.2.1",
      versionCode: "42",
      minSdk: "26",
      targetSdk: "36",
      iconPath: "res/mipmap-xxhdpi/ic_launcher.png",
      launcherActivity: "com.example.notes.MainActivity",
      debuggable: true,
      permissions: ["android.permission.CAMERA", "android.permission.INTERNET"],
      activities: ["com.example.notes.MainActivity", "com.example.notes.EditActivity"],
      services: ["com.example.notes.SyncService"],
      receivers: ["com.example.notes.BootReceiver"],
      providers: ["androidx.core.content.FileProvider"],
    });
  });

  it("searches file names and file contents", async () => {
    const id = "88888888-8888-4888-8888-888888888888";
    const dir = seedProject(id, { status: "ready" }, { decoded: true });
    const decoded = path.join(dir, "decoded");
    mkdirSync(path.join(decoded, "smali", "com", "example"), { recursive: true });
    mkdirSync(path.join(decoded, "build"), { recursive: true });
    writeFileSync(path.join(decoded, "smali", "com", "example", "Login.smali"), ".class public Lcom/example/Login;\nconst-string v0, \"api_token\"\n");
    writeFileSync(path.join(decoded, "res", "values", "strings.xml"), "<resources/>");
    writeFileSync(path.join(decoded, "build", "Login.smali"), "api_token");
    const byName = await searchInspector(COMPANY, id, "files", "login", "name");
    expect(byName.results.map((hit) => hit.path)).toEqual(["smali/com/example/Login.smali"]);
    const byText = await searchInspector(COMPANY, id, "files", "API_TOKEN", "text");
    expect(byText.results).toEqual([{ path: "smali/com/example/Login.smali", dir: false, line: 2, preview: 'const-string v0, "api_token"' }]);
    expect((await searchInspector(COMPANY, id, "files", "x", "text")).results).toEqual([]);
  });

  it("refuses an upload that isn't an APK, and keeps nothing of it", async () => {
    await expect(
      startDecodeFromStream({ companyId: COMPANY, label: "notes", stream: Readable.from([Buffer.from("just some text, not a zip")]) }),
    ).rejects.toThrow(/isn't an APK/);
    await expect(
      startDecodeFromStream({ companyId: COMPANY, label: "big", stream: Readable.from([Buffer.alloc(64)]), maxBytes: 16 }),
    ).rejects.toThrow(/larger than/);
    expect(listInspectorProjects(COMPANY)).toEqual([]);
  });
});
