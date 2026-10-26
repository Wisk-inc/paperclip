import { ModelLogo } from "@/components/ModelLogo";
import { cn } from "@/lib/utils";

/**
 * The chat model's maker and the paired image model's maker, shown as two
 * overlapping logo tiles that lean into each other — a small "bond" mark that
 * animates in with a kiss and then breathes, to show the two are paired.
 */
export function BondedModelLogos({
  chatModelId,
  imageModelId,
  size = "sm",
  className,
}: {
  chatModelId: string;
  imageModelId: string;
  size?: "xs" | "sm" | "md";
  className?: string;
}) {
  return (
    <span
      data-slot="bonded-model-logos"
      aria-hidden="true"
      className={cn("relative inline-flex items-center", className)}
    >
      <span className="bond-logo bond-logo-left relative z-10 drop-shadow-sm">
        <ModelLogo modelId={chatModelId} size={size} />
      </span>
      <span className="bond-logo bond-logo-right relative z-20 -ml-1.5 drop-shadow-sm">
        <ModelLogo modelId={imageModelId} size={size} />
      </span>
    </span>
  );
}
