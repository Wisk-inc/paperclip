import { cn } from "@/lib/utils";

/** GitHub's mark, dark on light surfaces and light on dark ones. */
export function GitHubMark({ className }: { className?: string }) {
  return (
    <span className={cn("relative inline-flex size-4 shrink-0", className)} aria-hidden="true">
      <img src="/brands/apps/github.svg" alt="" className="size-full dark:hidden" draggable={false} />
      <img src="/brands/apps/github-dark.svg" alt="" className="hidden size-full dark:block" draggable={false} />
    </span>
  );
}
