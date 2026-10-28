import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { studioChildEnv } from "../services/studio/runner.js";

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

/** The free-model token's pieces, read from the one server-only file that holds them. */
function tokenPieces(): string[] {
  const source = readFileSync(path.join(REPO, "packages/shared/src/puter-ai.ts"), "utf8");
  const list = source.match(/const _P = \[([\s\S]*?)\];/)?.[1] ?? "";
  return [...list.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]!).filter((piece) => piece.length >= 12);
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
  it("knows the token's pieces it is checking for", () => {
    expect(tokenPieces().length).toBeGreaterThan(3);
  });

  it.each(BUNDLES.map((dir) => [path.relative(REPO, dir), dir]))("%s carries no piece of the free-model token and no key", (_name, dir) => {
    const pieces = tokenPieces();
    const found: string[] = [];
    for (const file of textFilesUnder(dir)) {
      const text = readFileSync(file, "utf8");
      if (pieces.some((piece) => text.includes(piece))) found.push(`token piece in ${path.relative(REPO, file)}`);
      for (const shape of KEY_SHAPES) if (shape.test(text)) found.push(`${shape.source.slice(0, 16)} in ${path.relative(REPO, file)}`);
    }
    expect(found).toEqual([]);
  });
});
