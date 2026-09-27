import { ChevronRight, FolderSync, Inbox, ShieldCheck, Users } from "lucide-react";
import { Link } from "@/lib/router";
import { useInboxBadge } from "../hooks/useInboxBadge";
import { useDeviceFilesBadge } from "../hooks/useDeviceFilesBadge";
import { cn } from "../lib/utils";

interface NeedsYouListProps {
  companyId: string;
  pendingApprovals: number | null;
}

/**
 * The phone home screen's first answer to "does anything need me?": one
 * full-width row per queue, each a single tap from the thumb. Counts that
 * need action read in the foreground; empty queues stay quiet but visible,
 * so the rows never jump around between visits.
 */
export function NeedsYouList({ companyId, pendingApprovals }: NeedsYouListProps) {
  const inbox = useInboxBadge(companyId);
  const files = useDeviceFilesBadge(companyId);

  const rows = [
    { to: "/inbox", label: "Inbox", hint: "Unread updates", count: inbox.inbox, icon: Inbox },
    { to: "/approvals", label: "Approvals", hint: "Hires, budgets, plans", count: pendingApprovals ?? 0, icon: ShieldCheck },
    { to: "/device-files", label: "File requests", hint: "Agents waiting on a file", count: files.pendingRequests, icon: FolderSync },
    { to: "/agents/all", label: "Agents", hint: "Who is working on what", count: null, icon: Users },
  ];

  return (
    <section aria-labelledby="needs-you-heading" className="md:hidden">
      <h2 id="needs-you-heading" className="mb-2 text-sm font-medium text-muted-foreground">
        Needs you
      </h2>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {rows.map((row) => {
          const Icon = row.icon;
          const active = row.count != null && row.count > 0;
          return (
            <li key={row.to}>
              <Link
                to={row.to}
                className="flex min-h-14 items-center gap-3 px-4 py-2 text-inherit no-underline transition-colors duration-150 active:bg-accent"
              >
                <Icon className={cn("h-5 w-5 shrink-0", active ? "text-foreground" : "text-muted-foreground")} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{row.label}</span>
                  <span className="block truncate text-xs text-muted-foreground">{row.hint}</span>
                </span>
                {row.count != null ? (
                  <span
                    className={cn(
                      "min-w-7 rounded-md px-2 py-0.5 text-center text-sm tabular-nums",
                      active ? "bg-foreground font-semibold text-background" : "text-muted-foreground",
                    )}
                  >
                    {row.count > 99 ? "99+" : row.count}
                  </span>
                ) : null}
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
