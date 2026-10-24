import { useEffect, useMemo, useState } from "react";
import { Bell } from "lucide-react";
import { Link } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useInboxBadge } from "../hooks/useInboxBadge";
import { haptic } from "../lib/haptics";
import { bellSeenStorageKey, loadBellSeenKeys, saveBellSeenKeys } from "../lib/inbox";

/**
 * The phone header's inbox: a bell with the count of items that arrived since
 * it was last tapped. Tapping it opens the inbox and clears the count; the
 * inbox itself still lists everything. It sits in the header so the tab bar
 * keeps five thumb-sized destinations (Home, Chats, New, Tasks, Files).
 */
export function InboxBell() {
  const { selectedCompanyId } = useCompany();
  const { keys } = useInboxBadge(selectedCompanyId);
  const [seen, setSeen] = useState<Set<string>>(() => loadBellSeenKeys(selectedCompanyId));
  useEffect(() => {
    setSeen(loadBellSeenKeys(selectedCompanyId));
    const onStorage = (event: StorageEvent) => {
      if (event.key === bellSeenStorageKey(selectedCompanyId)) setSeen(loadBellSeenKeys(selectedCompanyId));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [selectedCompanyId]);
  const unseen = useMemo(() => keys.filter((key) => !seen.has(key)).length, [keys, seen]);
  const label = unseen > 0 ? `Inbox, ${unseen} new` : "Inbox";
  const markSeen = () => {
    haptic("tick");
    const next = new Set(keys);
    saveBellSeenKeys(next, selectedCompanyId);
    setSeen(next);
  };
  return (
    <Link
      to="/inbox"
      aria-label={label}
      title="Inbox"
      data-slot="inbox-bell"
      onClick={markSeen}
      className="relative ml-1 inline-flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-accent"
    >
      <Bell className="size-5" aria-hidden="true" />
      {unseen > 0 ? (
        <span
          data-testid="inbox-bell-count"
          className="absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-(length:--text-nano) font-semibold leading-none text-white tabular-nums"
        >
          {unseen > 99 ? "99+" : unseen}
        </span>
      ) : null}
    </Link>
  );
}
