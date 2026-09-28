import { useMemo } from "react";
import { NavLink } from "@/lib/router";
import {
  House,
  CircleCheck,
  Plus,
  FolderSync,
  MessagesSquare,
} from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { SIDEBAR_SCROLL_RESET_STATE } from "../lib/navigation-scroll";
import { cn } from "../lib/utils";
import { haptic } from "../lib/haptics";
import { useDeviceFilesBadge } from "../hooks/useDeviceFilesBadge";

interface MobileBottomNavProps {
  visible: boolean;
}

interface MobileNavLinkItem {
  type: "link";
  to: string;
  label: string;
  icon: typeof House;
  badge?: number;
  badgeLabel?: string;
}

interface MobileNavActionItem {
  type: "action";
  label: string;
  icon: typeof Plus;
  onClick: () => void;
}

type MobileNavItem = MobileNavLinkItem | MobileNavActionItem;

function BadgeCount({ count, label }: { count: number; label: string }) {
  return (
    <span
      className="absolute -right-2 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-(length:--text-nano) font-semibold leading-none text-white tabular-nums"
      aria-label={`${count} ${label}`}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

/**
 * The phone's primary navigation, placed in the thumb zone. Destinations are
 * the jobs people do on a phone: check what changed (Home), talk to an agent
 * (Chats), start work (New), follow work (Tasks), and move files to and from
 * agents (Files). The inbox lives in the header as a bell. Every cell is a full-height tap target;
 * the active one reads by weight and a filled indicator, not by color.
 */
export function MobileBottomNav({ visible }: MobileBottomNavProps) {
  const { selectedCompanyId } = useCompany();
  const { openNewIssue } = useDialogActions();
  const filesBadge = useDeviceFilesBadge(selectedCompanyId);

  const items = useMemo<MobileNavItem[]>(
    () => [
      { type: "link", to: "/dashboard", label: "Home", icon: House },
      { type: "link", to: "/chats", label: "Chats", icon: MessagesSquare },
      { type: "action", label: "New task", icon: Plus, onClick: () => openNewIssue() },
      { type: "link", to: "/issues", label: "Tasks", icon: CircleCheck },
      {
        type: "link",
        to: "/device-files",
        label: "Files",
        icon: FolderSync,
        badge: filesBadge.pendingRequests,
        badgeLabel: "file requests waiting",
      },
    ],
    [openNewIssue, filesBadge.pendingRequests],
  );

  return (
    <nav
      className={cn(
        "fixed bottom-0 left-0 right-0 z-30 border-t border-border bg-background transition-transform duration-200 ease-out motion-reduce:transition-none md:hidden pb-(--sz-safe-bottom)",
        visible ? "translate-y-0" : "translate-y-full",
      )}
      aria-label="Mobile navigation"
    >
      <div className="grid h-16 grid-cols-5 px-1">
        {items.map((item) => {
          const Icon = item.icon;
          if (item.type === "action") {
            return (
              <button
                key={item.label}
                type="button"
                onClick={() => {
                  haptic("tick");
                  item.onClick();
                }}
                className="group flex min-w-0 flex-col items-center justify-center gap-1 text-(length:--text-micro) font-medium text-foreground"
              >
                <span className="flex h-9 w-12 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-(--tp-color-background-color-border-color-box-shadow-opacity-scale) duration-150 group-active:scale-92 group-active:bg-primary/85 motion-reduce:group-active:scale-100">
                  <Icon className="h-5 w-5 stroke-(length:--sw-2_3)" />
                </span>
                <span className="sr-only">{item.label}</span>
              </button>
            );
          }

          return (
            <NavLink
              key={item.label}
              to={item.to}
              state={SIDEBAR_SCROLL_RESET_STATE}
              className={({ isActive }) =>
                cn(
                  "flex min-w-0 flex-col items-center justify-center gap-0.5 text-(length:--text-micro) transition-colors duration-150",
                  isActive ? "font-semibold text-foreground" : "font-medium text-muted-foreground",
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span
                    className={cn(
                      "relative flex h-7 w-12 items-center justify-center rounded-md transition-colors duration-150",
                      isActive && "bg-accent",
                    )}
                  >
                    <Icon className={cn("h-5 w-5", isActive && "stroke-(length:--sw-2_3)")} />
                    {item.badge != null && item.badge > 0 ? (
                      <BadgeCount count={item.badge} label={item.badgeLabel ?? "new"} />
                    ) : null}
                  </span>
                  <span className="truncate">{item.label}</span>
                </>
              )}
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}
