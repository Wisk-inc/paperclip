import { rmSync, unlinkSync, type Stats } from "node:fs";

/**
 * Removes a directory entry without following it, given its `lstat`: a symlink is unlinked, so
 * only the link goes and never what it points at; a real directory goes with what it holds;
 * anything else is removed. Quiet when the entry is already gone.
 *
 * A symlink is not removed with `rmSync`: on Node 24.11 (fixed by 24.22), `rmSync` without
 * `recursive` follows a link to a directory and throws "Path is a directory".
 */
export function removeEntryWithoutFollowing(entry: string, stats: Stats): void {
  if (stats.isSymbolicLink()) {
    try {
      unlinkSync(entry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return;
  }
  rmSync(entry, { recursive: stats.isDirectory(), force: true });
}
