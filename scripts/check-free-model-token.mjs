#!/usr/bin/env node
/**
 * check-free-model-token.mjs <file-or-dir>...
 *
 * Fails when Automa's built-in free-model token can be read in any file under
 * the given paths: whole, as a run of its signature (the token split into
 * short strings, as an earlier build stored it), or merely base64'd. The token
 * is kept XOR-masked in packages/shared/src/puter-ai.ts; this check proves no
 * build step (a stale dist, a bundler, the Android app) put it back in a form a
 * plain `strings` or `grep` would find.
 *
 * The token is read the way the service receives it, from a request's
 * Authorization header with fetch stubbed, so the check does not depend on how
 * it is masked. Only file paths and counts are printed, never the token or any
 * piece of it.
 *
 * Usage: node scripts/check-free-model-token.mjs <file-or-dir>...
 * Directories are walked without following symbolic links. Archives are not
 * opened: unpack them first.
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUTER_SOURCE = path.join(repoRoot, "packages", "shared", "src", "puter-ai.ts");
const TSX_API = path.join(repoRoot, "cli", "node_modules", "tsx", "dist", "esm", "api", "index.mjs");

/** A run of this many characters of the token's signature counts as the token. */
export const SIGNATURE_RUN = 10;

/**
 * What a file must not hold: the whole token, its payload and signature whole,
 * every SIGNATURE_RUN-character run of the signature, and the token base64'd at
 * each of the three byte alignments. The signature is random bytes, so a run of
 * it turns up nowhere by chance, while a token cut into short strings still
 * leaves such runs. The payload is JSON whose runs other tokens share, so only
 * its whole form is looked for.
 */
export function tokenNeedles(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
    throw new Error("The free-model token is not a three-part token, so it cannot be looked for.");
  }
  const [, payload, signature] = parts;
  if (signature.length < SIGNATURE_RUN * 2) {
    throw new Error("The free-model token's signature is too short to look for in pieces.");
  }
  const needles = new Set([token, payload, signature]);
  for (let at = 0; at + SIGNATURE_RUN <= signature.length; at += 1) {
    needles.add(signature.slice(at, at + SIGNATURE_RUN));
  }
  // base64 of the token after 0, 1 or 2 other bytes: drop the characters that
  // also carry those bytes or the padding, and what is left is fixed by the
  // token alone. Both alphabets: standard and URL-safe.
  for (const lead of ["", "\u0000", "\u0000\u0000"]) {
    const core = Buffer.from(lead + token, "latin1").toString("base64").replace(/=+$/, "").slice(4, -4);
    needles.add(core);
    needles.add(core.replaceAll("+", "-").replaceAll("/", "_"));
  }
  return [...needles].map((needle) => Buffer.from(needle, "latin1"));
}

/** Every regular file under the given paths; symbolic links are not followed. */
export function filesUnder(roots) {
  const files = [];
  const visit = (entry) => {
    const stats = lstatSync(entry, { throwIfNoEntry: false });
    if (!stats || stats.isSymbolicLink()) return;
    if (stats.isDirectory()) {
      for (const name of readdirSync(entry)) visit(path.join(entry, name));
    } else if (stats.isFile()) {
      files.push(entry);
    }
  };
  for (const root of roots) {
    if (!existsSync(root)) throw new Error(`Nothing to check at ${root}.`);
    visit(root);
  }
  return files;
}

/** The files under `roots` that hold any of `needles`, and how many files were read. */
export function findToken(roots, needles) {
  const files = filesUnder(roots);
  const hits = [];
  for (const file of files) {
    const content = readFileSync(file);
    if (needles.some((needle) => content.includes(needle))) hits.push(file);
  }
  return { checked: files.length, hits };
}

/**
 * The token a request carries when no operator token is set. `load` imports
 * the free-model module; by default the TypeScript source through tsx, so the
 * check always reads the token the source holds now.
 */
export async function readFreeModelToken(load = defaultLoad) {
  const savedFetch = globalThis.fetch;
  const hadEnv = Object.hasOwn(process.env, "PUTER_AUTH_TOKEN");
  const savedEnv = process.env.PUTER_AUTH_TOKEN;
  delete process.env.PUTER_AUTH_TOKEN;
  let header = "";
  globalThis.fetch = async (_url, init) => {
    header = String(init?.headers?.Authorization ?? "");
    return new Response(JSON.stringify({ usage: {}, allowanceInfo: { remaining: 1, monthUsageAllowance: 1 } }), { status: 200 });
  };
  try {
    const puter = await load();
    puter.resetFreeModelAllowance?.();
    await puter.freeModelAllowance();
  } finally {
    globalThis.fetch = savedFetch;
    if (hadEnv) process.env.PUTER_AUTH_TOKEN = savedEnv;
  }
  if (!header.startsWith("Bearer ") || header.length <= "Bearer ".length) {
    throw new Error("No request carried the free-model token, so it cannot be looked for.");
  }
  return header.slice("Bearer ".length);
}

async function defaultLoad() {
  if (!existsSync(TSX_API)) {
    throw new Error(`${path.relative(repoRoot, TSX_API)} is missing: run pnpm install first.`);
  }
  const { tsImport } = await import(pathToFileURL(TSX_API).href);
  return tsImport(pathToFileURL(PUTER_SOURCE).href, import.meta.url);
}

export async function main(roots, { load = defaultLoad, log = console.log, error = console.error } = {}) {
  if (roots.length === 0) {
    error("Usage: node scripts/check-free-model-token.mjs <file-or-dir>...");
    return 2;
  }
  const needles = tokenNeedles(await readFreeModelToken(load));
  const { checked, hits } = findToken(roots, needles);
  if (hits.length > 0) {
    error(`FREE-MODEL TOKEN READABLE in ${hits.length} of ${checked} files:`);
    for (const hit of hits.slice(0, 20)) error(`  ${hit}`);
    if (hits.length > 20) error(`  … and ${hits.length - 20} more`);
    return 1;
  }
  log(`free-model token: not readable in any of ${checked} files (whole, in pieces or base64'd)`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (caught) => {
      console.error(caught instanceof Error ? caught.message : String(caught));
      process.exit(1);
    },
  );
}
