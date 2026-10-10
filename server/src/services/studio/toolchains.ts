import { accessSync, constants, existsSync } from "node:fs";
import path from "node:path";
import { STUDIO_LANGUAGES, type StudioLanguage, type StudioToolchainStatus } from "@paperclipai/shared";

export type StudioHostPlatform = StudioToolchainStatus["platform"];

/** Termux (Android), Debian-family Linux, macOS, or something else. */
export function studioHostPlatform(): StudioHostPlatform {
  if (process.platform === "android" || (process.env.PREFIX ?? "").includes("com.termux")) return "termux";
  if (process.platform === "darwin") return "mac";
  if (process.platform === "linux" && (existsSync("/etc/debian_version") || existsSync("/usr/bin/apt-get"))) return "debian";
  return "other";
}

const lookupCache = new Map<string, { at: number; found: string | null }>();
const CACHE_MS = 15_000;

/** The absolute path of `program` on PATH, or null. */
export function findOnPath(program: string, extraDirs: readonly string[] = []): string | null {
  const key = `${program}\0${extraDirs.join(":")}`;
  const cached = lookupCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.found;
  let found: string | null = null;
  const dirs = [...extraDirs, ...(process.env.PATH ?? "").split(path.delimiter)].filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, program);
    try {
      accessSync(candidate, constants.X_OK);
      found = candidate;
      break;
    } catch {
      // not here
    }
  }
  lookupCache.set(key, { at: Date.now(), found });
  return found;
}

export function clearToolchainCache() {
  lookupCache.clear();
}

/** The command that installs a language's toolchain on this host, when we know one. */
export function installCommandFor(language: StudioLanguage, platform = studioHostPlatform()): string | null {
  if (!language.requires) return null;
  if (platform === "termux") return language.install.termux ? `pkg install -y ${language.install.termux}` : null;
  if (platform === "debian") return language.install.debian ? `sudo apt-get install -y ${language.install.debian}` : null;
  if (platform === "mac") return language.install.mac ? `brew install ${language.install.mac}` : null;
  return null;
}

export function toolchainStatus(language: StudioLanguage): StudioToolchainStatus {
  const platform = studioHostPlatform();
  const available = !language.requires || findOnPath(language.requires) !== null;
  return {
    languageId: language.id,
    requires: language.requires,
    available,
    installCommand: available ? null : installCommandFor(language, platform),
    note: language.install.note ?? null,
    platform,
  };
}

export function allToolchainStatuses(): StudioToolchainStatus[] {
  return STUDIO_LANGUAGES.map(toolchainStatus);
}
