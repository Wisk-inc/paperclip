import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { studioChildEnv } from "../services/studio/runner.js";
// The release check's own way of finding the token (scripts/check-free-model-token.mjs, tested beside it).
import { findToken, readFreeModelToken, tokenNeedles } from "../../../scripts/check-free-model-token.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// What a phone's server runs with (mobile/termux/install.sh) plus the usual provider keys.
const SERVER_SECRETS: Record<string, string> = {
  PAPERCLIP_LOCAL_TRUSTED_SECRET: "app-key-0123456789abcdef",
  PAPERCLIP_AGENT_JWT_SECRET: "agent-jwt-signing-secret",
  BETTER_AUTH_SECRET: "better-auth-signing-secret",
  DATABASE_URL: "postgres://u0_a123:db-password-value@127.0.0.1:5432/automa",
  PGPASSWORD: "db-password-value",
  PUTER_AUTH_TOKEN: "free-model-service-token",
  OPENAI_API_KEY: "openai-key-value",
  ANTHROPIC_API_KEY: "anthropic-key-value",
  GITHUB_TOKEN: "github-token-value",
};

describe("server secrets stay out of the apps Studio runs", () => {
  const saved = new Map<string, string | undefined>();

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  });

  it("drops the app key, database password, free-model token and provider keys", () => {
    for (const [key, value] of Object.entries(SERVER_SECRETS)) {
      saved.set(key, process.env[key]);
      process.env[key] = value;
    }
    const env = studioChildEnv({ PORT: "4000" });
    expect(env.PORT).toBe("4000");
    expect(env.PATH).toBe(process.env.PATH);
    for (const key of Object.keys(SERVER_SECRETS)) expect(env[key], key).toBeUndefined();
    const values = Object.values(env).join("\n");
    for (const value of Object.values(SERVER_SECRETS)) expect(values).not.toContain(value);
  });
});

/**
 * What a file must not hold of the free-model token: the release check's needles (the whole token,
 * its parts, every 10-character run of its signature, and the token base64'd), made from the token
 * a request carries now, so the check follows however packages/shared/src/puter-ai.ts masks it.
 * (It once read the token's pieces from a list in that file; when the token came to be stored
 * masked, the list was gone, and this check had nothing to look for.)
 */
async function tokenNeedlesNow(): Promise<Buffer[]> {
  return tokenNeedles(await readFreeModelToken(() => import("@paperclipai/shared/puter-ai")));
}

function textFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return textFilesUnder(full);
    return /\.(js|mjs|css|html|json|map|txt|svg|webmanifest)$/.test(entry.name) ? [full] : [];
  });
}

const KEY_SHAPES = [
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/,
  /AIza[0-9A-Za-z_-]{35}/,
  /\bgh[pousr]_[A-Za-z0-9]{36}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----\s*[A-Za-z0-9+/=]{40,}/,
];

// The web app as built, and the copy the Android app ships. Both are build
// output, so each is checked only when it is there.
const BUNDLES = ["ui/dist", "mobile/android/app/src/main/assets/ui", "mobile/android/app/src/main/assets/connect"]
  .map((dir) => path.join(REPO, dir))
  .filter((dir) => existsSync(dir));

describe.skipIf(BUNDLES.length === 0)("the built web app", () => {
  it("knows the token's pieces it is checking for", async () => {
    expect((await tokenNeedlesNow()).length).toBeGreaterThan(3);
  });

  it.each(BUNDLES.map((dir) => [path.relative(REPO, dir), dir]))("%s carries no piece of the free-model token and no key", async (_name, dir) => {
    // Only file names are reported, never the token or a piece of it.
    const { hits } = findToken([dir], await tokenNeedlesNow());
    const found = hits.map((file: string) => `token piece in ${path.relative(REPO, file)}`);
    for (const file of textFilesUnder(dir)) {
      const text = readFileSync(file, "utf8");
      for (const shape of KEY_SHAPES) if (shape.test(text)) found.push(`${shape.source.slice(0, 16)} in ${path.relative(REPO, file)}`);
    }
    expect(found).toEqual([]);
  });
});
