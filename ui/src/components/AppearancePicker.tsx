import { Check, Moon, Sun } from "lucide-react";
import { useTheme } from "../context/ThemeContext";
import { ACCENT_THEMES } from "../lib/accent-themes";
import { haptic } from "../lib/haptics";
import { cn } from "../lib/utils";

/**
 * Light or dark, and the app's accent color. Changes apply at once and are
 * remembered on this device.
 */
export function AppearancePicker({ className }: { className?: string }) {
  const { theme, setTheme, accent, setAccent } = useTheme();
  return (
    <div className={cn("flex flex-col gap-3", className)} data-slot="appearance-picker">
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1" role="radiogroup" aria-label="Light or dark">
        {(
          [
            ["light", "Light", Sun],
            ["dark", "Dark", Moon],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={theme === id}
            onClick={() => {
              haptic("tick");
              setTheme(id);
            }}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-md py-1.5 text-sm",
              theme === id ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground",
            )}
          >
            <Icon className="size-4" /> {label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-5" role="radiogroup" aria-label="Accent color">
        {ACCENT_THEMES.map((option) => {
          const selected = accent === option.id;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => {
                haptic("tick");
                setAccent(option.id);
              }}
              className={cn(
                "flex flex-col items-center gap-1.5 rounded-lg border p-2 text-xs transition-colors",
                selected ? "border-primary bg-accent font-medium text-accent-foreground" : "border-border text-muted-foreground hover:bg-accent/60",
              )}
              data-testid={`accent-${option.id}`}
            >
              <span
                className="relative flex size-8 items-center justify-center rounded-full shadow-sm ring-2 ring-background"
                style={{
                  backgroundImage:
                    option.swatch.length > 1
                      ? `linear-gradient(135deg, var(${option.swatch[0]}) 50%, var(${option.swatch[1]}) 50%)`
                      : `linear-gradient(135deg, var(${option.swatch[0]}), var(${option.swatch[0]}))`,
                }}
              >
                {selected ? <Check className="size-4 text-studio-badge-foreground drop-shadow" /> : null}
              </span>
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
