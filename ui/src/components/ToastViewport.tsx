import { useEffect, useState } from "react";
import { Link } from "@/lib/router";
import { X } from "lucide-react";
import {
  useToastActions,
  useToastState,
  type ToastItem,
  type ToastTone,
} from "../context/ToastContext";
import { cn } from "../lib/utils";

const toneClasses: Record<ToastTone, string> = {
  info: "border-zinc-300 bg-zinc-50 text-zinc-900 dark:border-zinc-500/25 dark:bg-zinc-950/95 dark:text-zinc-100",
  success: "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-500/25 dark:bg-emerald-950/95 dark:text-emerald-100",
  warn: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/25 dark:bg-amber-950/95 dark:text-amber-100",
  error: "border-red-300 bg-red-50 text-red-900 dark:border-red-500/30 dark:bg-red-950/95 dark:text-red-100",
};

const toneDotClasses: Record<ToastTone, string> = {
  info: "bg-zinc-500 dark:bg-zinc-400",
  success: "bg-emerald-500 dark:bg-emerald-400",
  warn: "bg-amber-500 dark:bg-amber-400",
  error: "bg-red-500 dark:bg-red-400",
};

function AnimatedToast({
  toast,
  onDismiss,
}: {
  toast: ToastItem;
  onDismiss: (id: string) => void;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <li
      className={cn(
        "pointer-events-auto rounded-sm border shadow-lg backdrop-blur-xl transition-(--tp-transform-opacity) duration-200 ease-out",
        visible
          ? "translate-y-0 opacity-100"
          : "translate-y-3 opacity-0",
        toneClasses[toast.tone],
      )}
    >
      <div className="flex items-start gap-3 px-3 py-2.5">
        <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", toneDotClasses[toast.tone])} />
        <div className="min-w-0 flex-1 py-0.5">
          <p className="text-sm font-semibold leading-5">{toast.title}</p>
          {toast.body && (
            <p className="mt-1 text-xs leading-4 opacity-70">
              {toast.body}
            </p>
          )}
        </div>
        {/* The action sits on the right as a full-size touch target (Undo, Open). */}
        {toast.action &&
          (toast.action.onClick ? (
            <button
              type="button"
              onClick={() => {
                toast.action?.onClick?.();
                onDismiss(toast.id);
              }}
              className="-my-1 inline-flex h-9 shrink-0 items-center rounded-md px-3 text-sm font-semibold hover:bg-black/10 dark:hover:bg-white/10"
            >
              {toast.action.label}
            </button>
          ) : toast.action.href ? (
            <Link
              to={toast.action.href}
              onClick={() => onDismiss(toast.id)}
              className="-my-1 inline-flex h-9 shrink-0 items-center rounded-md px-3 text-sm font-semibold no-underline hover:bg-black/10 dark:hover:bg-white/10"
            >
              {toast.action.label}
            </Link>
          ) : null)}
        <button
          type="button"
          aria-label="Dismiss notification"
          onClick={() => onDismiss(toast.id)}
          className="-my-1 -mr-1 flex size-9 shrink-0 items-center justify-center rounded-md opacity-50 hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </li>
  );
}

export function ToastViewport() {
  const toasts = useToastState();
  const { dismissToast } = useToastActions();

  if (toasts.length === 0) return null;

  return (
    <aside
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed inset-x-0 bottom-(--sz-calc-14) z-(--z-120) px-4 md:inset-x-auto md:bottom-3 md:left-3 md:w-full md:max-w-sm md:px-1"
    >
      <ol className="flex w-full flex-col-reverse gap-2">
        {toasts.map((toast) => (
          <AnimatedToast
            key={toast.id}
            toast={toast}
            onDismiss={dismissToast}
          />
        ))}
      </ol>
    </aside>
  );
}
