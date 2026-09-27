import { Plus, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { haptic } from "@/lib/haptics";

interface ThumbActionProps {
  label: string;
  onClick: () => void;
  icon?: LucideIcon;
  disabled?: boolean;
}

/**
 * A page's primary create action on phones, placed where the thumb already
 * rests: a large, centered button floating just above the tab bar (the
 * "thumb zone"), instead of a small button in the header at the top. It sits
 * on the tab-bar rung of the depth ladder, fades the content scrolling
 * behind it, and leaves a spacer in the page flow so the last row is never
 * hidden behind it.
 *
 * On md+ screens it renders nothing; keep the header button there, where a
 * mouse reaches it just as easily, and hide that header button below md
 * (`hidden md:inline-flex`) so each screen has exactly one primary action.
 */
export function ThumbAction({ label, onClick, icon: Icon = Plus, disabled = false }: ThumbActionProps) {
  return (
    <>
      <div aria-hidden="true" className="h-16 md:hidden" />
      <div className="pointer-events-none fixed inset-x-0 bottom-(--sz-calc-14) z-30 flex justify-center bg-linear-to-t from-background via-background/80 to-transparent px-4 pt-6 pb-2 md:hidden">
        <Button
          size="lg"
          disabled={disabled}
          onClick={() => {
            haptic("tick");
            onClick();
          }}
          className="pointer-events-auto h-12 min-w-48 max-w-full rounded-full px-6 text-base shadow-lg"
          data-slot="thumb-action"
        >
          <Icon className="size-5" />
          <span className="truncate">{label}</span>
        </Button>
      </div>
    </>
  );
}
