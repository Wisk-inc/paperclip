import { Bell } from "lucide-react";
import { Link } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useInboxBadge } from "../hooks/useInboxBadge";
import { haptic } from "../lib/haptics";

/**
 * The phone header's inbox: a bell with the unread count. It sits in the
 * header so the tab bar keeps five thumb-sized destinations (Home, Chats,
 * New, Tasks, Files).
 */
export function InboxBell() {
  const { selectedCompanyId } = useCompany();
  const { inbox } = useInboxBadge(selectedCompanyId);
  const label = inbox > 0 ? `Inbox, ${inbox} unread` : "Inbox";
  return (
    <Link
      to="/inbox"
      aria-label={label}
      title="Inbox"
      data-slot="inbox-bell"
      onClick={() => haptic("tick")}
      className="relative ml-1 inline-flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-accent"
    >
      <Bell className="size-5" aria-hidden="true" />
      {inbox > 0 ? (
        <span className="absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-(length:--text-nano) font-semibold leading-none text-white tabular-nums">
          {inbox > 99 ? "99+" : inbox}
        </span>
      ) : null}
    </Link>
  );
}
