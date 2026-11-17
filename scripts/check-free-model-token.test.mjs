import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SIGNATURE_RUN, filesUnder, findToken, main, readFreeModelToken, tokenNeedles } from "./check-free-model-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Made-up tokens shaped like the real one: a standard header, a JSON payload
// and a random signature. The real token never appears in these tests.
function fakeToken() {
  const part = (value) => Buffer.from(value).toString("base64url");
  const header = part(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = part(JSON.stringify({ type: "app-under-user", version: "0.0.0", uuid: randomUUID(), app_uid: `app-${randomUUID()}`, iat: 1760000000 }));
  return `${header}.${payload}.${part(randomBytes(32))}`;
}

function tempDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "free-model-token-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function hits(dir, token) {
  return findToken([dir], tokenNeedles(token)).hits.map((file) => path.relative(dir, file)).sort();
}

test("refuses a token it could not look for", () => {
  assert.throws(() => tokenNeedles("not-a-token"), /three-part/);
  assert.throws(() => tokenNeedles("a.b.c d"), /three-part/);
  assert.throws(() => tokenNeedles("aaaa.bbbb.short"), /too short/);
});

test("finds the token whole in a bundled file", (t) => {
  const dir = tempDir(t);
  const token = fakeToken();
  writeFileSync(path.join(dir, "bundle.js"), `var a=1;const t="${token}";export{t};`);
  writeFileSync(path.join(dir, "clean.js"), "export const nothing = 1;\n");
  assert.deepEqual(hits(dir, token), ["bundle.js"]);
});

test("finds the token cut into short strings joined at run time, as an earlier build stored it", (t) => {
  const dir = tempDir(t);
  const token = fakeToken();
  // Any cut into pieces of SIGNATURE_RUN characters or more leaves a whole run
  // of the signature in one piece. These are the lengths the old layout used.
  for (const sizes of [[14, 22, 30, 17], [30, 14], [SIGNATURE_RUN]]) {
    const pieces = [];
    for (let at = 0, index = 0; at < token.length; index += 1) {
      const size = sizes[index % sizes.length];
      pieces.push(token.slice(at, at + size));
      at += size;
    }
    writeFileSync(path.join(dir, `split-${sizes.join("-")}.js`), `const _P = [${pieces.map((piece) => `'${piece}'`).join(", ")}];\nconst T = _P.join('');\n`);
  }
  assert.deepEqual(hits(dir, token), ["split-10.js", "split-14-22-30-17.js", "split-30-14.js"]);
});

test("finds the token base64'd, alone or inside larger text, at every alignment and in both alphabets", (t) => {
  const dir = tempDir(t);
  const token = fakeToken();
  const expected = [];
  for (const prefix of ["", "a", "ab"]) {
    for (const encoding of ["base64", "base64url"]) {
      const name = `config-${prefix.length}-${encoding}.txt`;
      writeFileSync(path.join(dir, name), Buffer.from(`${prefix}{"token":"${token}","more":"data"}`).toString(encoding));
      expected.push(name);
    }
  }
  writeFileSync(path.join(dir, "alone.txt"), Buffer.from(token).toString("base64"));
  expected.push("alone.txt");
  assert.deepEqual(hits(dir, token), expected.sort());
});

test("finds the token inside a binary file", (t) => {
  const dir = tempDir(t);
  const token = fakeToken();
  writeFileSync(path.join(dir, "classes.dex"), Buffer.concat([randomBytes(4096), Buffer.from(token), Buffer.from([0]), randomBytes(4096)]));
  assert.deepEqual(hits(dir, token), ["classes.dex"]);
});

test("passes the masked form, other tokens and harmless fragments", (t) => {
  const dir = tempDir(t);
  const token = fakeToken();
  // The masked layout puter-ai.ts uses: XOR with a random mask, both base64'd.
  const mask = randomBytes(24);
  const masked = Buffer.from(token, "latin1").map((byte, index) => byte ^ mask[index % mask.length]);
  writeFileSync(path.join(dir, "puter-ai.js"), `const _M='${mask.toString("base64")}';const _E='${Buffer.from(masked).toString("base64")}';`);
  writeFileSync(path.join(dir, "other-token.js"), `const other="${fakeToken()}";`);
  // The standard header every such token shares, and a run one short of the limit.
  const [header, , signature] = token.split(".");
  writeFileSync(path.join(dir, "fragments.txt"), `${header}\n${signature.slice(0, SIGNATURE_RUN - 1)}\n`);
  assert.deepEqual(hits(dir, token), []);
});

test("walks nested directories but never follows a symbolic link", (t) => {
  const dir = tempDir(t);
  const outside = tempDir(t);
  const token = fakeToken();
  mkdirSync(path.join(dir, "a", "b", "c"), { recursive: true });
  writeFileSync(path.join(dir, "a", "b", "c", "deep.js"), token);
  writeFileSync(path.join(outside, "elsewhere.js"), token);
  symlinkSync(outside, path.join(dir, "a", "link-to-outside"));
  symlinkSync(path.join(outside, "elsewhere.js"), path.join(dir, "link-to-file.js"));
  // A loop back to the top would never end if links were followed.
  symlinkSync(dir, path.join(dir, "a", "b", "loop"));
  assert.deepEqual(hits(dir, token), [path.join("a", "b", "c", "deep.js")]);
  assert.equal(filesUnder([dir]).length, 1);
});

test("a path that does not exist is an error, not a pass", () => {
  assert.throws(() => filesUnder([path.join(os.tmpdir(), `missing-${randomUUID()}`)]), /Nothing to check/);
});

function fakeModule(builtIn, requests = []) {
  return async () => ({
    resetFreeModelAllowance() {},
    async freeModelAllowance() {
      const token = process.env.PUTER_AUTH_TOKEN || builtIn;
      requests.push(token);
      const reply = await fetch("https://usage.invalid/report", { headers: { Authorization: `Bearer ${token}` } });
      return reply.json();
    },
  });
}

test("reads the built-in token from a request, not an operator's, and puts fetch and the environment back", async (t) => {
  const savedEnv = process.env.PUTER_AUTH_TOKEN;
  t.after(() => {
    if (savedEnv === undefined) delete process.env.PUTER_AUTH_TOKEN;
    else process.env.PUTER_AUTH_TOKEN = savedEnv;
  });
  const fetchBefore = globalThis.fetch;
  const builtIn = fakeToken();
  process.env.PUTER_AUTH_TOKEN = "operator-token";
  assert.equal(await readFreeModelToken(fakeModule(builtIn)), builtIn);
  assert.equal(process.env.PUTER_AUTH_TOKEN, "operator-token");
  assert.equal(globalThis.fetch, fetchBefore);

  delete process.env.PUTER_AUTH_TOKEN;
  await assert.rejects(readFreeModelToken(async () => { throw new Error("module failed to load"); }), /module failed to load/);
  assert.equal(Object.hasOwn(process.env, "PUTER_AUTH_TOKEN"), false);
  assert.equal(globalThis.fetch, fetchBefore);

  await assert.rejects(readFreeModelToken(async () => ({ async freeModelAllowance() {} })), /No request carried/);
});

test("main names the files that hold the token and never prints the token or a piece of it", async (t) => {
  const dir = tempDir(t);
  const token = fakeToken();
  writeFileSync(path.join(dir, "leaky.js"), `const t = "${token}";`);
  const out = [];
  const code = await main([dir], { load: fakeModule(token), log: (line) => out.push(line), error: (line) => out.push(line) });
  assert.equal(code, 1);
  const printed = out.join("\n");
  assert.match(printed, /READABLE in 1 of 1 files/);
  assert.ok(printed.includes(path.join(dir, "leaky.js")));
  for (const needle of tokenNeedles(token)) assert.equal(printed.includes(needle.toString("latin1")), false);
});

test("main passes a clean tree and asks for paths when given none", async (t) => {
  const dir = tempDir(t);
  writeFileSync(path.join(dir, "clean.js"), "export const ok = true;\n");
  const out = [];
  const sink = { load: fakeModule(fakeToken()), log: (line) => out.push(line), error: (line) => out.push(line) };
  assert.equal(await main([dir], sink), 0);
  assert.match(out.at(-1), /not readable in any of 1 files/);
  assert.equal(await main([], sink), 2);
});

// Loads packages/shared/src/puter-ai.ts through tsx with fetch stubbed: no
// request leaves the machine. The source must hold the token masked only. A
// checkout without dependencies installed reports this test as skipped.
const tsxInstalled = existsSync(path.join(repoRoot, "cli", "node_modules", "tsx", "dist", "esm", "api", "index.mjs"));
test("the repository's free-model source passes its own check", { skip: tsxInstalled ? false : "needs pnpm install (tsx)" }, async () => {
  const out = [];
  const code = await main([path.join(repoRoot, "packages", "shared", "src")], { log: (line) => out.push(line), error: (line) => out.push(line) });
  assert.equal(code, 0, out.join("\n"));
});
