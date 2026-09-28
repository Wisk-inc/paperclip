import { useState } from "react";
import { modelBrand, providerBrand, vendorDisplayName, type ModelProvider } from "@/lib/model-brand";
import { cn } from "@/lib/utils";

const SIZES = {
  xs: { tile: "size-4 rounded-sm p-px", text: "text-nano" },
  sm: { tile: "size-5 rounded-sm p-0.5", text: "text-nano" },
  md: { tile: "size-8 rounded-md p-1.5", text: "text-xs" },
  lg: { tile: "size-10 rounded-lg p-2", text: "text-sm" },
} as const;
export type ModelLogoSize = keyof typeof SIZES;

interface ModelLogoProps {
  /** The model id; the maker is read from it. */
  modelId?: string | null;
  /** Fallback maker when the id is empty. */
  adapterType?: string | null;
  /** Show a provider's logo directly instead of reading it from a model id. */
  provider?: ModelProvider;
  size?: ModelLogoSize;
  /** Draw the logo on a card tile (default) or bare. */
  tile?: boolean;
  className?: string;
}

/**
 * The maker's logo for an AI model: Anthropic for Claude, DeepSeek for
 * DeepSeek V4, and so on. Monochrome marks swap to their white variant on
 * dark surfaces. A maker without a logo gets its initial on the same tile, so
 * every row in a model list lines up.
 */
export function ModelLogo({ modelId, adapterType, provider, size = "sm", tile = true, className }: ModelLogoProps) {
  const brand = provider ? providerBrand(provider) : modelBrand(modelId, adapterType);
  const [failed, setFailed] = useState(false);
  const { tile: tileClass, text } = SIZES[size];
  const initial = (brand.provider === "other" ? vendorDisplayName(modelId) : brand.providerName).charAt(0).toUpperCase();
  return (
    <span
      data-slot="model-logo"
      data-provider={brand.provider}
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden",
        tile && "border border-border bg-card",
        tileClass,
        className,
      )}
    >
      {brand.logo && !failed ? (
        <>
          <img
            src={brand.logo}
            alt=""
            draggable={false}
            loading="lazy"
            decoding="async"
            className={cn("size-full object-contain", brand.darkLogo && "dark:hidden")}
            onError={() => setFailed(true)}
          />
          {brand.darkLogo ? (
            <img src={brand.darkLogo} alt="" draggable={false} loading="lazy" decoding="async" className="hidden size-full object-contain dark:block" />
          ) : null}
        </>
      ) : (
        <span className={cn("font-semibold leading-none text-muted-foreground", text)}>{initial || "?"}</span>
      )}
    </span>
  );
}
