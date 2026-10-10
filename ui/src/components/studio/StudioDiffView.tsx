import { useMemo } from "react";
import type { StudioChangeFile } from "@paperclipai/shared";
import { diffLines, diffStats, foldUnchanged } from "@/lib/studio-diff";
import { cn } from "@/lib/utils";

/**
 * One file's proposed change: removed lines on red, added lines on green,
 * with line numbers from both sides and long unchanged stretches folded.
 */
export function StudioFileDiff({ file }: { file: StudioChangeFile }) {
  const lines = useMemo(() => diffLines(file.before, file.after), [file.before, file.after]);
  const rows = useMemo(() => foldUnchanged(lines, 3), [lines]);
  const stats = diffStats(lines);
  const label = file.before === null ? "new file" : file.after === null ? "deleted" : null;

  return (
    <section className="overflow-hidden rounded-lg border border-border" data-testid={`studio-diff-${file.path}`}>
      <header className="flex items-center gap-2 border-b border-border bg-muted/50 px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium">{file.path}</span>
        {label ? <span className="text-xs text-muted-foreground">{label}</span> : null}
        <span className="font-mono text-xs text-studio-diff-add-mark">+{stats.added}</span>
        <span className="font-mono text-xs text-studio-diff-del-mark">−{stats.removed}</span>
      </header>
      <div className="overflow-x-auto font-mono text-(length:--text-compact) leading-relaxed">
        {rows.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">No changes.</p>
        ) : (
          rows.map((row, index) => {
            if (row.type === "skip") {
              return (
                <div key={`skip-${index}`} className="bg-muted/40 px-3 py-0.5 text-xs text-muted-foreground">
                  ⋯ {row.count} unchanged {row.count === 1 ? "line" : "lines"}
                </div>
              );
            }
            const oldNo = row.type === "add" ? "" : row.oldNo;
            const newNo = row.type === "del" ? "" : row.newNo;
            return (
              <div
                key={`${row.type}-${index}`}
                data-diff={row.type}
                className={cn(
                  "flex min-w-max",
                  row.type === "add" && "bg-studio-diff-add text-studio-diff-add-foreground",
                  row.type === "del" && "bg-studio-diff-del text-studio-diff-del-foreground",
                )}
              >
                <span className="w-9 shrink-0 select-none pr-1 text-right text-muted-foreground/70">{oldNo}</span>
                <span className="w-9 shrink-0 select-none pr-1 text-right text-muted-foreground/70">{newNo}</span>
                <span
                  className={cn(
                    "w-4 shrink-0 select-none text-center",
                    row.type === "add" && "text-studio-diff-add-mark",
                    row.type === "del" && "text-studio-diff-del-mark",
                  )}
                  aria-hidden="true"
                >
                  {row.type === "add" ? "+" : row.type === "del" ? "−" : " "}
                </span>
                <span className="whitespace-pre pr-3">{row.text || " "}</span>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

export function StudioDiffView({ files }: { files: StudioChangeFile[] }) {
  return (
    <div className="flex flex-col gap-3">
      {files.map((file) => (
        <StudioFileDiff key={file.path} file={file} />
      ))}
    </div>
  );
}
