/**
 * Line diff for Studio's change review: which lines a collaborator removed
 * (shown red) and added (shown green). Common lines at both ends are matched
 * first; the middle uses a longest-common-subsequence table, which is exact
 * for the file sizes people edit by hand. Very large middles fall back to
 * "all old lines removed, all new lines added" so the screen stays fast.
 */

export type StudioDiffLine =
  | { type: "same"; text: string; oldNo: number; newNo: number }
  | { type: "del"; text: string; oldNo: number }
  | { type: "add"; text: string; newNo: number };

export type StudioDiffRow = StudioDiffLine | { type: "skip"; count: number };

const MAX_TABLE_CELLS = 4_000_000;

export function splitLines(text: string | null): string[] {
  if (text === null || text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function diffLines(before: string | null, after: string | null): StudioDiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const out: StudioDiffLine[] = [];
  for (let i = 0; i < start; i += 1) out.push({ type: "same", text: a[i]!, oldNo: i + 1, newNo: i + 1 });

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  if (n * m > MAX_TABLE_CELLS) {
    midA.forEach((text, i) => out.push({ type: "del", text, oldNo: start + i + 1 }));
    midB.forEach((text, j) => out.push({ type: "add", text, newNo: start + j + 1 }));
  } else if (n > 0 || m > 0) {
    // lcs[i][j]: longest common subsequence of midA[i..] and midB[j..].
    const width = m + 1;
    const lcs = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        lcs[i * width + j] = midA[i] === midB[j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        out.push({ type: "same", text: midA[i]!, oldNo: start + i + 1, newNo: start + j + 1 });
        i += 1;
        j += 1;
      } else if (j < m && (i === n || lcs[i * width + j + 1]! >= lcs[(i + 1) * width + j]!)) {
        out.push({ type: "add", text: midB[j]!, newNo: start + j + 1 });
        j += 1;
      } else {
        out.push({ type: "del", text: midA[i]!, oldNo: start + i + 1 });
        i += 1;
      }
    }
    // Show removals before additions inside each changed block.
    reorderBlocks(out);
  }

  const shift = endB - endA;
  for (let i = endA; i < a.length; i += 1) out.push({ type: "same", text: a[i]!, oldNo: i + 1, newNo: i + 1 + shift });
  return out;
}

function reorderBlocks(lines: StudioDiffLine[]) {
  let k = 0;
  while (k < lines.length) {
    if (lines[k]!.type === "same") {
      k += 1;
      continue;
    }
    let end = k;
    while (end < lines.length && lines[end]!.type !== "same") end += 1;
    const block = lines.slice(k, end);
    const sorted = [...block.filter((line) => line.type === "del"), ...block.filter((line) => line.type === "add")];
    lines.splice(k, block.length, ...sorted);
    k = end;
  }
}

/** Keeps `context` unchanged lines around each change and folds the rest. */
export function foldUnchanged(lines: StudioDiffLine[], context = 3): StudioDiffRow[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.type === "same") return;
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k += 1) keep[k] = true;
  });
  const rows: StudioDiffRow[] = [];
  let skipped = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (skipped) rows.push({ type: "skip", count: skipped });
      skipped = 0;
      rows.push(line);
    } else {
      skipped += 1;
    }
  });
  if (skipped) rows.push({ type: "skip", count: skipped });
  return rows;
}

export function diffStats(lines: StudioDiffLine[]) {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.type === "add") added += 1;
    else if (line.type === "del") removed += 1;
  }
  return { added, removed };
}
