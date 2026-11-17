import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { automaNative, type AutomaTroubleshootReport } from "../lib/automa-native";
import { haptic } from "../lib/haptics";

type Troubleshooting =
  | { state: "running" }
  | { state: "done"; report: AutomaTroubleshootReport }
  | { state: "failed"; message: string }
  /** Not inside the Automa app on the phone that runs Automa: it says how. */
  | { state: "manual" };

function title(troubleshooting: Troubleshooting): string {
  switch (troubleshooting.state) {
    case "running":
      return "Troubleshooting…";
    case "failed":
      return "Couldn't run the troubleshooter";
    case "manual":
      return "Troubleshoot Automa";
    case "done":
      if (troubleshooting.report.pending) return "The troubleshooter is taking a while";
      return troubleshooting.report.problems ? "Found problems: what to do is in the report" : "No problems found";
  }
}

function description(troubleshooting: Troubleshooting): string {
  switch (troubleshooting.state) {
    case "running":
      return "Checking Termux, storage, Automa's files, the database and Automa itself. This takes a few seconds.";
    case "failed":
      return troubleshooting.message;
    case "manual":
      return "On the phone that runs Automa, open Termux and run the command below. It checks Termux, storage, Automa's files and the database, fixes what it safely can, and says what to do about the rest.";
    case "done":
      return troubleshooting.report.pending
        ? "It is still running in Termux. To see its report there, open Termux and run: automa troubleshoot"
        : "It fixed what it safely could (it never changes your board's data).";
  }
}

/**
 * The troubleshooter (`automa troubleshoot` in Termux), from the board. In the
 * Automa app on the phone that runs Automa, opening this runs it and shows its
 * report; anywhere else it says how to run it in Termux.
 */
export function TroubleshootDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [troubleshooting, setTroubleshooting] = useState<Troubleshooting>({ state: "running" });
  // One run per opening; a reply after the dialog closed is dropped.
  const run = useRef(0);

  useEffect(() => {
    if (!open) return;
    const current = ++run.current;
    if (!automaNative.canTroubleshoot()) {
      setTroubleshooting({ state: "manual" });
      return;
    }
    setTroubleshooting({ state: "running" });
    automaNative.troubleshoot().then(
      (report) => {
        if (run.current !== current) return;
        haptic(report.problems ? "warning" : "success");
        setTroubleshooting({ state: "done", report });
      },
      (failure: unknown) => {
        if (run.current !== current) return;
        haptic("warning");
        setTroubleshooting({ state: "failed", message: failure instanceof Error ? failure.message : "The troubleshooter didn't run." });
      },
    );
    return () => {
      run.current += 1;
    };
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="troubleshoot-dialog">
        <DialogHeader>
          <DialogTitle>{title(troubleshooting)}</DialogTitle>
          <DialogDescription>{description(troubleshooting)}</DialogDescription>
        </DialogHeader>
        {troubleshooting.state === "manual" ? (
          <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-sm">automa troubleshoot</pre>
        ) : null}
        {troubleshooting.state === "done" && troubleshooting.report.output ? (
          <pre
            data-testid="troubleshoot-report"
            className="max-h-(--sz-50vh) overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted px-3 py-2 font-mono text-xs leading-relaxed"
          >
            {troubleshooting.report.output}
          </pre>
        ) : null}
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}
