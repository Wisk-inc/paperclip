import { linkSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";

/**
 * Errors a filesystem returns when it refuses hard links rather than the
 * target: Android app storage (SELinux denies `link` to apps, which is where
 * Termux keeps its home), FAT/exFAT volumes, and some network mounts.
 */
const HARD_LINK_REFUSED = new Set(["EACCES", "EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "EMLINK"]);

export function isHardLinkRefused(error: unknown): boolean {
  return HARD_LINK_REFUSED.has((error as NodeJS.ErrnoException | undefined)?.code ?? "");
}

/**
 * Publishes a finished `temporaryPath` at `finalPath` only if nothing is there
 * yet, throwing EEXIST otherwise. A hard link does this atomically. Where hard
 * links are refused, the same content is written with an exclusive create
 * (O_EXCL), which still never replaces a file another process published first.
 * A genuine permission problem on the directory fails that create too, so it
 * still surfaces.
 */
export function publishExclusiveSync(
  temporaryPath: string,
  finalPath: string,
  content: string | Buffer,
  mode?: number,
): void {
  try {
    linkSync(temporaryPath, finalPath);
  } catch (error) {
    if (!isHardLinkRefused(error)) throw error;
    writeFileSync(finalPath, content, { flag: "wx", ...(mode === undefined ? {} : { mode }) });
  }
}

/** Async form of {@link publishExclusiveSync}. */
export async function publishExclusive(
  temporaryPath: string,
  finalPath: string,
  content: string | Buffer,
  mode?: number,
): Promise<void> {
  try {
    await fs.link(temporaryPath, finalPath);
  } catch (error) {
    if (!isHardLinkRefused(error)) throw error;
    await fs.writeFile(finalPath, content, { flag: "wx", ...(mode === undefined ? {} : { mode }) });
  }
}
