import type { IssueWorkMode } from "@paperclipai/shared";
import { ClipboardList, Hammer, MessageCircleQuestion, type LucideIcon } from "lucide-react";

export type WorkModeTone = "neutral" | "ask" | "planning";

export interface WorkModeMeta {
  value: IssueWorkMode;
  label: string;
  icon: LucideIcon;
  tone: WorkModeTone;
  classes: {
    chip: string;
    container: string;
    menuItem: string;
    badge: string;
  };
}

const STANDARD_CLASSES = {
  chip: "border-border bg-muted/40 text-muted-foreground hover:bg-accent hover:text-foreground",
  container: "",
  menuItem: "text-foreground",
  badge: "",
};

const ASK_CLASSES = {
  chip: "border-zinc-500/60 bg-zinc-500/15 text-zinc-800 hover:bg-zinc-500/25 dark:border-zinc-500/50 dark:bg-zinc-500/15 dark:text-zinc-200 dark:hover:bg-zinc-500/25",
  container: "border-zinc-500/60 bg-zinc-50/60 supports-[backdrop-filter]:bg-zinc-50/40 dark:border-zinc-500/50 dark:bg-zinc-500/[0.07] dark:supports-[backdrop-filter]:bg-zinc-500/[0.07]",
  menuItem: "text-zinc-700 dark:text-zinc-300",
  badge: "border-zinc-500/40 bg-zinc-50 text-zinc-700 dark:border-zinc-500/40 dark:bg-zinc-500/10 dark:text-zinc-200",
};

const PLANNING_CLASSES = {
  chip: "border-amber-500/60 bg-amber-500/15 text-amber-800 hover:bg-amber-500/25 dark:border-amber-500/50 dark:bg-amber-500/15 dark:text-amber-200 dark:hover:bg-amber-500/25",
  container: "border-amber-500/60 bg-amber-50/60 supports-[backdrop-filter]:bg-amber-50/40 dark:border-amber-500/50 dark:bg-amber-500/[0.07] dark:supports-[backdrop-filter]:bg-amber-500/[0.07]",
  menuItem: "text-amber-700 dark:text-amber-300",
  badge: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
};

export function isIssueWorkMode(value: unknown): value is IssueWorkMode {
  return value === "standard" || value === "ask" || value === "planning";
}

export function workModeMetaList(): WorkModeMeta[] {
  return [
    {
      value: "standard",
      label: "Auto mode",
      icon: Hammer,
      tone: "neutral",
      classes: STANDARD_CLASSES,
    },
    {
      value: "planning",
      label: "Plan mode",
      icon: ClipboardList,
      tone: "planning",
      classes: PLANNING_CLASSES,
    },
    {
      value: "ask",
      label: "Ask mode",
      icon: MessageCircleQuestion,
      tone: "ask",
      classes: ASK_CLASSES,
    },
  ];
}

export function workModeMetaFor(mode: IssueWorkMode): WorkModeMeta {
  const modes = workModeMetaList();
  return modes.find((meta) => meta.value === mode) ?? modes[0]!;
}

export function nextWorkMode(mode: IssueWorkMode): IssueWorkMode {
  const modes = workModeMetaList();
  const index = modes.findIndex((meta) => meta.value === mode);
  return modes[(index + 1) % modes.length]?.value ?? "standard";
}

export function titleForPendingWorkMode(mode: IssueWorkMode): string {
  if (mode === "ask") {
    return "Ask mode for this submission. Click to change. The responsible will answer in this thread; no implementation work.";
  }
  if (mode === "planning") {
    return "Plan mode is on for this submission. Click to change.";
  }
  return "Auto mode for this submission. Click to change.";
}
