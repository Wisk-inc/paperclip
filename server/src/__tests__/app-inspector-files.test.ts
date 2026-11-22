import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ root: "", log: vi.fn(async () => undefined) }));

vi.mock("../home-paths.js", () => ({ resolvePaperclipInstanceRoot: () => state.root }));
vi.mock("../services/ai-connections.js", () => ({ aiConnectionService: () => ({ credentialForProvider: async () => null }) }));
vi.mock("../services/activity-log.js", () => ({ logActivity: state.log }));

import { __resetInspector, inspectorAppInfo, startRebuild } from "../services/app-inspector/inspector.js";

const COMPANY = "company-1";
const PROJECT = "99999999-9999-4999-8999-999999999999";
const base = `/api/companies/${COMPANY}/app-inspector/projects/${PROJECT}`;
const projectDir = () => path.join(state.root, "app-inspector", PROJECT);
const decoded = (...parts: string[]) => path.join(projectDir(), "decoded", ...parts);

async function createApp() {
  const [{ appInspectorRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/app-inspector.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use((req, _res, next) => {
    (req as any).actor = { type: "board", userId: "local-board", companyIds: [COMPANY], source: "local_implicit", isInstanceAdmin: true };
    next();
  });
  app.use("/api", appInspectorRoutes({} as any, { deploymentMode: "local_trusted", deploymentExposure: "private" }));
  app.use(errorHandler);
  return app;
}

/** A project folder as an earlier server run left it. */
function seed(meta: Record<string, unknown> = {}) {
  const dir = projectDir();
  mkdirSync(decoded("assets"), { recursive: true });
  mkdirSync(path.join(dir, "java", "sources"), { recursive: true });
  writeFileSync(decoded("AndroidManifest.xml"), '<manifest package="com.example"/>');
  writeFileSync(
    path.join(dir, "project.json"),
    JSON.stringify({ id: PROJECT, companyId: COMPANY, label: "Example", status: "ready", decoded: true, java: "ready", createdAt: "2026-11-22T00:00:00.000Z", ...meta }),
  );
}

const savedProject = () => JSON.parse(readFileSync(path.join(projectDir(), "project.json"), "utf8")) as Record<string, unknown>;

describe("App Inspector files", () => {
  beforeEach(() => {
    state.root = mkdtempSync(path.join(os.tmpdir(), "automa-inspector-files-"));
    state.log.mockClear();
    __resetInspector();
  });
  afterEach(() => {
    __resetInspector();
    rmSync(state.root, { recursive: true, force: true });
  });

  describe("a text file that is not UTF-8", () => {
    const original = Buffer.from("title=Caf\xe9 cr\xe8me\nbye=\xc0 bient\xf4t\n", "latin1");

    it("opens for reading only, and a save is refused with its bytes left as they were", async () => {
      seed();
      writeFileSync(decoded("assets", "messages_fr.properties"), original);
      const app = await createApp();

      const read = await request(app).get(`${base}/file?view=files&path=assets/messages_fr.properties`);
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ binary: false, truncated: false, readOnly: true });

      const write = await request(app)
        .put(`${base}/file`)
        .send({ path: "assets/messages_fr.properties", text: String(read.body.text).replace("bye=", "goodbye=") });
      expect(write.status).toBe(422);
      expect(write.body.error).toBe("This file isn't UTF-8 text; saving it here would change its other characters.");
      expect(readFileSync(decoded("assets", "messages_fr.properties")).equals(original)).toBe(true);
      expect(state.log).not.toHaveBeenCalled();
    });

    it("leaves UTF-8 text with accents editable", async () => {
      seed();
      writeFileSync(decoded("assets", "messages_fr.properties"), "title=Café crème\n", "utf8");
      const app = await createApp();
      const read = await request(app).get(`${base}/file?view=files&path=assets/messages_fr.properties`);
      expect(read.body).toMatchObject({ text: "title=Café crème\n", readOnly: false });
      const write = await request(app).put(`${base}/file`).send({ path: "assets/messages_fr.properties", text: "title=Café noir\n" });
      expect(write.status).toBe(200);
      expect(readFileSync(decoded("assets", "messages_fr.properties"), "utf8")).toBe("title=Café noir\n");
    });
  });

  describe("a decode that failed", () => {
    it("is still not decoded after a restart, though apktool left a half-written tree", async () => {
      seed({ status: "failed", decoded: false, java: "none", error: "apktool could not decode this APK. See the log." });
      const app = await createApp();

      const project = await request(app).get(base);
      expect(project.body.project).toMatchObject({ status: "failed", decoded: false });

      const dir = await request(app).get(`${base}/dir?view=files&path=`);
      expect(dir.status).toBe(422);
      expect(dir.body.error).toBe("This app is not decoded yet.");

      expect(() => startRebuild(COMPANY, PROJECT)).toThrow(/not decoded/);
      expect((await request(app).post(`${base}/rebuild`)).status).toBe(422);
      const write = await request(app).put(`${base}/file`).send({ path: "AndroidManifest.xml", text: "<manifest/>" });
      expect(write.status).toBe(422);
      expect(readFileSync(decoded("AndroidManifest.xml"), "utf8")).toBe('<manifest package="com.example"/>');
    });

    it("keeps a project saved before `decoded` was stored", async () => {
      seed({ decoded: undefined });
      const project = await request(await createApp()).get(base);
      expect(project.body.project).toMatchObject({ status: "ready", decoded: true });
    });
  });

  describe("the launcher activity", () => {
    it("is the one with the LAUNCHER category, not a self-closing activity before it", async () => {
      seed();
      // The shape apktool writes: an activity with no children is self-closing.
      writeFileSync(
        decoded("AndroidManifest.xml"),
        `<?xml version="1.0" encoding="utf-8" standalone="no"?><manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.shop">
    <application android:label="Shop">
        <activity android:name="com.example.shop.SettingsActivity"/>
        <activity android:exported="true" android:name="com.example.shop.MainActivity">
            <intent-filter>
                <action android:name="android.intent.action.MAIN"/>
                <category android:name="android.intent.category.LAUNCHER"/>
            </intent-filter>
        </activity>
        <activity-alias android:name="com.example.shop.Alias" android:targetActivity="com.example.shop.MainActivity"/>
    </application>
</manifest>`,
      );
      const info = await inspectorAppInfo(COMPANY, PROJECT);
      expect(info.launcherActivity).toBe("com.example.shop.MainActivity");
      const viaRoute = await request(await createApp()).get(`${base}/info`);
      expect(viaRoute.body.info.launcherActivity).toBe("com.example.shop.MainActivity");
    });

    it("can be an alias, and is none when no activity has the category", async () => {
      seed();
      writeFileSync(
        decoded("AndroidManifest.xml"),
        `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.shop"><application>
  <activity android:name="com.example.shop.MainActivity"/>
  <activity-alias android:name="com.example.shop.Start" android:targetActivity="com.example.shop.MainActivity"><intent-filter><category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity-alias>
</application></manifest>`,
      );
      expect((await inspectorAppInfo(COMPANY, PROJECT)).launcherActivity).toBe("com.example.shop.Start");
      writeFileSync(decoded("AndroidManifest.xml"), '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application><activity android:name="a.B"/></application></manifest>');
      expect((await inspectorAppInfo(COMPANY, PROJECT)).launcherActivity).toBeNull();
    });
  });

  describe("the lists read from the manifest", () => {
    it("list screens without their aliases, and permissions asked either way", async () => {
      seed();
      writeFileSync(
        decoded("AndroidManifest.xml"),
        `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.shop">
  <uses-permission android:name="android.permission.INTERNET"/>
  <uses-permission-sdk-23 android:name="android.permission.CAMERA"/>
  <application>
    <activity android:name="com.example.shop.MainActivity"/>
    <activity
        android:name="com.example.shop.SettingsActivity"/>
    <activity-alias android:name="com.example.shop.Start" android:targetActivity="com.example.shop.MainActivity"/>
    <service android:name="com.example.shop.SyncService"/>
  </application>
</manifest>`,
      );
      const info = await inspectorAppInfo(COMPANY, PROJECT);
      expect(info.activities).toEqual(["com.example.shop.MainActivity", "com.example.shop.SettingsActivity"]);
      expect(info.permissions).toEqual(["android.permission.CAMERA", "android.permission.INTERNET"]);
      expect(info.services).toEqual(["com.example.shop.SyncService"]);
    });
  });

  describe("an edit after a build", () => {
    it("stops offering the APK built before it", async () => {
      const out = path.join(state.root, "app-inspector", PROJECT, "out", "Example-automa.apk");
      seed({ status: "built", outputPath: out, downloadsPath: "/sdcard/Download/Example-automa.apk" });
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, "PK old build");
      const app = await createApp();
      expect((await request(app).get(base)).body.project).toMatchObject({ status: "built", hasOutput: true });

      const write = await request(app).put(`${base}/file`).send({ path: "AndroidManifest.xml", text: '<manifest package="com.example.changed"/>' });
      expect(write.status).toBe(200);

      const after = await request(app).get(base);
      expect(after.body.project).toMatchObject({ status: "ready", hasOutput: false, outputName: null, downloadsPath: null });
      expect((await request(app).get(`${base}/output`)).status).toBe(404);
      // And it stays that way after a restart.
      expect(savedProject()).toMatchObject({ status: "ready", outputPath: null, downloadsPath: null });
    });

    it("keeps the build when the save was refused", async () => {
      const out = path.join(state.root, "app-inspector", PROJECT, "out", "Example-automa.apk");
      seed({ status: "built", outputPath: out });
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, "PK old build");
      writeFileSync(decoded("icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
      const app = await createApp();
      expect((await request(app).put(`${base}/file`).send({ path: "icon.png", text: "oops" })).status).toBe(422);
      expect((await request(app).get(base)).body.project).toMatchObject({ status: "built", hasOutput: true });
    });
  });

  describe("a link inside the tree that leads out of the project", () => {
    let outside: string;
    let app: express.Express;

    beforeEach(async () => {
      seed();
      outside = path.join(state.root, "outside-secret.txt");
      writeFileSync(outside, "TOP SECRET outside the project\n");
      writeFileSync(path.join(state.root, "outside.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      symlinkSync(outside, decoded("assets", "notes.txt"));
      symlinkSync(state.root, decoded("assets", "up"));
      symlinkSync(path.join(state.root, "outside.png"), decoded("assets", "pic.png"));
      symlinkSync(path.join(state.root, "not-there-yet.txt"), decoded("assets", "dangling.txt"));
      app = await createApp();
    });

    const refused = (res: request.Response) => {
      expect(res.status).toBe(422);
      expect(res.body.error).toBe("That path leads outside this app's files.");
      expect(JSON.stringify(res.body)).not.toContain(state.root);
      expect(JSON.stringify(res.body)).not.toContain("TOP SECRET");
    };

    it("is not read, through a linked file or a linked folder", async () => {
      refused(await request(app).get(`${base}/file?view=files&path=assets/notes.txt`));
      refused(await request(app).get(`${base}/file?view=files&path=assets/up/outside-secret.txt`));
    });

    it("is not listed", async () => {
      refused(await request(app).get(`${base}/dir?view=files&path=assets/up`));
      // The folder that holds the links still lists, and shows them as plain entries.
      const list = await request(app).get(`${base}/dir?view=files&path=assets`);
      expect(list.status).toBe(200);
      expect(list.body.entries).toEqual(
        ["dangling.txt", "notes.txt", "pic.png", "up"].map((name) => ({ name, path: `assets/${name}`, dir: false, size: null })),
      );
    });

    it("is not written, whether the file is there, new, or the link's target is missing", async () => {
      refused(await request(app).put(`${base}/file`).send({ path: "assets/notes.txt", text: "overwritten from the inspector\n" }));
      expect(readFileSync(outside, "utf8")).toBe("TOP SECRET outside the project\n");

      refused(await request(app).put(`${base}/file`).send({ path: "assets/up/planted.txt", text: "planted\n" }));
      expect(existsSync(path.join(state.root, "planted.txt"))).toBe(false);

      // A link whose target is missing would be created through: it is not taken for a new file.
      const dangling = await request(app).put(`${base}/file`).send({ path: "assets/dangling.txt", text: "planted\n" });
      expect(dangling.status).toBe(422);
      expect(dangling.body.error).toBe("That is a link, and what it points to isn't there.");
      expect(existsSync(path.join(state.root, "not-there-yet.txt"))).toBe(false);
      expect(state.log).not.toHaveBeenCalled();
    });

    it("is not served as an image", async () => {
      refused(await request(app).get(`${base}/image?view=files&path=assets/pic.png`));
      refused(await request(app).get(`${base}/image?view=files&path=assets/up/outside.png`));
    });

    it("is not searched", async () => {
      const byText = await request(app).get(`${base}/search?view=files&mode=text&q=${encodeURIComponent("TOP SECRET")}`);
      expect(byText.body).toEqual({ results: [], truncated: false });
      const byName = await request(app).get(`${base}/search?view=files&mode=name&q=outside`);
      expect(byName.body).toEqual({ results: [], truncated: false });
    });

    it("is refused in the Java view too", async () => {
      symlinkSync(outside, path.join(projectDir(), "java", "sources", "Secret.java"));
      refused(await request(app).get(`${base}/file?view=java&path=Secret.java`));
    });

    it("still opens a link that stays inside the tree, and saves new files beside real ones", async () => {
      symlinkSync(decoded("AndroidManifest.xml"), decoded("assets", "manifest-link.xml"));
      const read = await request(app).get(`${base}/file?view=files&path=assets/manifest-link.xml`);
      expect(read.status).toBe(200);
      expect(read.body.text).toBe('<manifest package="com.example"/>');

      const write = await request(app).put(`${base}/file`).send({ path: "assets/new.txt", text: "new\n" });
      expect(write.status).toBe(200);
      expect(readFileSync(decoded("assets", "new.txt"), "utf8")).toBe("new\n");
      const missingFolder = await request(app).put(`${base}/file`).send({ path: "no-such-folder/new.txt", text: "new\n" });
      expect(missingFolder.status).toBe(422);
      expect(missingFolder.body.error).toBe("That file or folder isn't there.");
    });
  });

  describe("the activity log", () => {
    it("records a saved file with its path, and nothing for a save that was refused", async () => {
      seed();
      const app = await createApp();
      expect((await request(app).put(`${base}/file`).send({ path: "AndroidManifest.xml", text: "<manifest/>" })).status).toBe(200);
      expect(state.log).toHaveBeenCalledTimes(1);
      expect(state.log).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          companyId: COMPANY,
          actorType: "user",
          actorId: "local-board",
          action: "app_inspector.file_saved",
          entityType: "app_inspector_project",
          entityId: PROJECT,
          details: { path: "AndroidManifest.xml" },
        }),
      );
      state.log.mockClear();
      expect((await request(app).put(`${base}/file`).send({ path: "../project.json", text: "{}" })).status).toBe(422);
      expect(state.log).not.toHaveBeenCalled();
    });

    it("records a deleted project, and nothing when there was none to delete", async () => {
      seed();
      const app = await createApp();
      expect((await request(app).delete(base)).body).toEqual({ ok: true });
      expect(existsSync(projectDir())).toBe(false);
      expect(state.log).toHaveBeenCalledTimes(1);
      expect(state.log).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ companyId: COMPANY, actorType: "user", actorId: "local-board", action: "app_inspector.deleted", entityType: "app_inspector_project", entityId: PROJECT }),
      );
      state.log.mockClear();
      expect((await request(app).delete(base)).body).toEqual({ ok: false });
      expect(state.log).not.toHaveBeenCalled();
    });
  });
});
