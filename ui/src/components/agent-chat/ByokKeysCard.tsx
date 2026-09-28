import { Check, KeyRound } from "lucide-react";
import type { AiProvider } from "@paperclipai/shared";
import { ModelLogo } from "@/components/ModelLogo";
import { Button } from "@/components/ui/button";
import type { ModelProvider } from "@/lib/model-brand";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";

/** Providers that take your own key, in the order people usually connect them. */
export const BYOK_PROVIDERS: Array<{ provider: AiProvider; name: string; brand: ModelProvider; hint: string }> = [
  { provider: "openrouter", name: "OpenRouter", brand: "openrouter", hint: "DeepSeek, Mistral, Llama, Qwen, GLM, and 450+ more" },
  { provider: "anthropic", name: "Anthropic", brand: "anthropic", hint: "Claude" },
  { provider: "openai", name: "OpenAI", brand: "openai", hint: "GPT and Codex" },
  { provider: "xai", name: "xAI", brand: "xai", hint: "Grok" },
];

export function connectKeyHref(provider: AiProvider) {
  return `/apps/connect?source=${encodeURIComponent(provider)}`;
}

/** "Bring your own key": one row per provider, connected or a one-tap Add key. */
export function ByokKeysCard({ connected, className }: { connected: ReadonlySet<AiProvider>; className?: string }) {
  return (
    <section aria-label="Your API keys" className={cn("rounded-xl border border-border bg-card p-3", className)}>
      <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <KeyRound className="size-4 text-muted-foreground" aria-hidden="true" />
        Your API keys
      </h3>
      <p className="mt-0.5 text-xs text-muted-foreground">Bring your own key. Keys are stored encrypted on your Automa server.</p>
      <ul className="mt-2 divide-y divide-border">
        {BYOK_PROVIDERS.map(({ provider, name, brand, hint }) => (
          <li key={provider} className="flex items-center gap-3 py-2" data-byok-provider={provider}>
            <ModelLogo provider={brand} size="md" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-foreground">{name}</span>
              <span className="block truncate text-xs text-muted-foreground">{hint}</span>
            </span>
            {connected.has(provider) ? (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                <Check className="size-3.5" aria-hidden="true" />Connected
              </span>
            ) : (
              <Button variant="outline" size="sm" asChild>
                <Link to={connectKeyHref(provider)} aria-label={`Add your ${name} key`}>Add key</Link>
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
