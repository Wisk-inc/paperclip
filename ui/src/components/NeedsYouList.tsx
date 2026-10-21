import { ChevronRight, CodeXml, FolderSync, Inbox, ShieldCheck, Users } from "lucide-react";
import { Link } from "@/lib/router";
import { useInboxBadge } from "../hooks/useInboxBadge";
import { useDeviceFilesBadge } from "../hooks/useDeviceFilesBadge";
import { cn } from "../lib/utils";
import { useQuery } from "@tanstack/react-query";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { useRecentTasks } from "../hooks/useRecentTasks";
import { Mascot } from "./mascot/Mascot";
import { useAccountProfile } from "../hooks/useAccountProfile";
import { AccountButton } from "./account/AccountSheet";

function greetingFor(hour: number): string {
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

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
    { to: "/studio", label: "App Studio", hint: "Build and run your own apps", count: null, icon: CodeXml },
  ];

  const waiting = inbox.inbox + (pendingApprovals ?? 0) + files.pendingRequests;
  // Where you were last: the most recent task or chat you opened, one tap away.
  const { data: session } = useQuery({ queryKey: queryKeys.auth.session, queryFn: () => authApi.getSession(), retry: false });
  const userId = session?.user?.id ?? session?.session?.userId ?? null;
  const { entries: recentTasks } = useRecentTasks({ companyId, userId });
  const lastTask = recentTasks[0] ?? null;
  const profile = useAccountProfile();
  const firstName = profile.firstName;
  const greeting = `${greetingFor(new Date().getHours())}${firstName ? `, ${firstName}` : ""}`;

  return (
    <section aria-labelledby="needs-you-heading" className="flex flex-col gap-4 md:hidden">
      {/* Greeting: the mascot cheers when nothing is waiting and perks up when something is. */}
      <div className="flex items-center gap-4 rounded-lg border border-border bg-card p-4">
        <Mascot pose={waiting > 0 ? "excited" : "cheering"} size="sm" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="font-display text-lg font-semibold leading-tight tracking-tight">{greeting}</p>
          <p className="text-sm text-muted-foreground">
            {waiting > 0
              ? `${waiting} ${waiting === 1 ? "thing needs" : "things need"} you. Start at the top.`
              : "You're all caught up. Your agents are on it."}
          </p>
          {lastTask ? (
            <Link
              to={`/issues/${lastTask.id}`}
              className="mt-1 flex min-w-0 max-w-full items-center gap-1 text-sm font-medium text-foreground no-underline"
              data-testid="home-continue"
            >
              <span className="shrink-0 text-muted-foreground">Pick up:</span>
              <span className="min-w-0 truncate">{lastTask.title}</span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </Link>
          ) : null}
        </div>
        <AccountButton size="md" className="self-start" />
      </div>
      <h2 id="needs-you-heading" className="-mb-2 text-sm font-medium text-muted-foreground">
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
