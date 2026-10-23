import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, Eye, EyeOff, KeyRound, Loader2, Star, Trash2 } from "lucide-react";
import { cleanPastedApiKey, type AiManagedConnectionSummary, type AiProvider } from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { toolsApi } from "@/api/tools";
import { ModelLogo } from "@/components/ModelLogo";
import { Mascot } from "@/components/mascot/Mascot";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToastActions } from "@/context/ToastContext";
import { copyTextToClipboard } from "@/lib/clipboard";
import { haptic } from "@/lib/haptics";
import type { ModelProvider } from "@/lib/model-brand";
import { cn } from "@/lib/utils";

/** The providers that take a key, in the order people usually connect them. */
const PROVIDERS: Array<{ id: AiProvider; name: string; brand: ModelProvider; keyUrl: string; hint: string; placeholder: string }> = [
  { id: "anthropic", name: "Anthropic", brand: "anthropic", keyUrl: "https://console.anthropic.com/settings/keys", hint: "Claude. Agents, chats, and App Studio use it.", placeholder: "sk-ant-…" },
  { id: "openai", name: "OpenAI", brand: "openai", keyUrl: "https://platform.openai.com/api-keys", hint: "GPT and Codex.", placeholder: "sk-…" },
  { id: "openrouter", name: "OpenRouter", brand: "openrouter", keyUrl: "https://openrouter.ai/keys", hint: "Hundreds of models behind one key.", placeholder: "sk-or-…" },
  { id: "xai", name: "xAI", brand: "xai", keyUrl: "https://console.x.ai", hint: "Grok.", placeholder: "xai-…" },
];

const STATUS_LABEL: Record<AiManagedConnectionSummary["status"], string> = {
  connected: "Working",
  needs_attention: "Needs attention",
  expired: "Expired",
  revoked: "Removed",
};

function providerName(provider: AiProvider) {
  return PROVIDERS.find((item) => item.id === provider)?.name ?? provider;
}

/**
 * One page for the keys the whole app runs on: agents, the chat model picker,
 * and App Studio's assistant all read from here. Add a key, copy it back out,
 * pick the default, or remove it. Keys stay encrypted on the Automa server.
 */
export function ApiKeys() {
  const { selectedCompanyId: companyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const client = useQueryClient();
  const { pushToast } = useToastActions();
  useEffect(() => {
    setBreadcrumbs([{ label: "API keys" }]);
  }, [setBreadcrumbs]);

  const listKey = useMemo(() => ["ai-connections", companyId] as const, [companyId]);
  const connections = useQuery({
    queryKey: listKey,
    queryFn: () => aiConnectionsApi.list(companyId!),
    enabled: Boolean(companyId),
  });
  const keys = useMemo(
    () => (connections.data?.connections ?? []).filter((item) => item.status !== "revoked"),
    [connections.data],
  );

  const [provider, setProvider] = useState<AiProvider>("anthropic");
  const [keyInput, setKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const info = PROVIDERS.find((item) => item.id === provider)!;

  const refresh = () => client.invalidateQueries({ queryKey: ["ai-connections"] });

  const add = useMutation({
    mutationFn: async () => {
      const apiKey = cleanPastedApiKey(keyInput);
      const created = await aiConnectionsApi.create(companyId!, {
        provider,
        method: "api_key",
        // The last characters tell two keys for the same provider apart.
        name: `${info.name} key ··${apiKey.slice(-4)}`,
        ownership: "personal",
        apiKey,
        agentIds: [],
        allAgents: true,
      });
      // The server keeps an earlier default, so a replaced key went on being
      // used (or, once removed, none was). The key added here is the one the
      // toast promises everything will use.
      const madeDefault = await aiConnectionsApi.setDefault(companyId!, created.grantId).then(() => true, () => false);
      return { ...created, madeDefault };
    },
    onSuccess: async ({ madeDefault }) => {
      haptic("success");
      setKeyInput("");
      setShowKey(false);
      await refresh();
      pushToast({
        title: `${info.name} key saved`,
        body: madeDefault
          ? "Agents, chats, and App Studio can use it now."
          : "Saved, but it isn't your default yet. Tap Make default to use it.",
        tone: madeDefault ? "success" : "warn",
      });
    },
    onError: (error) => {
      haptic("warning");
      pushToast({ title: "Couldn't save the key", body: error instanceof Error ? error.message : String(error), tone: "error" });
    },
  });

  const remove = useMutation({
    mutationFn: (connectionId: string) => toolsApi.archiveConnection(connectionId),
    onSuccess: async () => {
      haptic("success");
      setConfirmRemove(null);
      await refresh();
      pushToast({ title: "Key removed", tone: "success" });
    },
    onError: (error) => {
      haptic("warning");
      pushToast({ title: "Couldn't remove the key", body: error instanceof Error ? error.message : String(error), tone: "error" });
    },
  });

  const makeDefault = useMutation({
    mutationFn: (grantId: string) => aiConnectionsApi.setDefault(companyId!, grantId),
    onSuccess: async () => {
      haptic("tick");
      await refresh();
    },
    onError: (error) => {
      pushToast({ title: "Couldn't change the default", body: error instanceof Error ? error.message : String(error), tone: "error" });
    },
  });

  const copyKey = async (connection: AiManagedConnectionSummary) => {
    try {
      const { apiKey } = await aiConnectionsApi.reveal(companyId!, connection.id);
      await copyTextToClipboard(apiKey);
      haptic("success");
      setCopied(connection.id);
      window.setTimeout(() => setCopied((current) => (current === connection.id ? null : current)), 2000);
    } catch (error) {
      haptic("warning");
      pushToast({ title: "Couldn't copy the key", body: error instanceof Error ? error.message : String(error), tone: "error" });
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!keyInput.trim() || add.isPending) return;
    add.mutate();
  };

  if (!companyId) return null;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6" data-testid="api-keys-page">
      <header className="flex flex-col gap-1">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <KeyRound className="size-5 text-muted-foreground" aria-hidden="true" />
          API keys
        </h1>
        <p className="text-sm text-muted-foreground">
          One place for the keys everything runs on: your agents, the chat model picker, and App Studio&apos;s assistant.
          Keys are encrypted on your Automa server and never leave it.
        </p>
      </header>

      <section aria-label="Your keys" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Your keys</h2>
        {connections.isPending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Loading…
          </p>
        ) : connections.isError ? (
          <p className="text-sm text-destructive">{connections.error instanceof Error ? connections.error.message : "Couldn't load your keys."}</p>
        ) : keys.length === 0 ? (
          <div className="flex items-center gap-4 rounded-xl border border-dashed border-border p-4" data-testid="api-keys-empty">
            <Mascot pose="thinking" size="sm" />
            <p className="text-sm text-muted-foreground">No keys yet. Add one below and every agent can start working.</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="api-keys-list">
            {keys.map((connection) => {
              const isKey = connection.method === "api_key";
              return (
                <li key={connection.id} className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3" data-testid="api-key-row" data-provider={connection.provider}>
                  <div className="flex items-center gap-3">
                    <ModelLogo provider={connection.provider as ModelProvider} size="md" />
                    <div className="min-w-0 flex-1">
                      <p className="flex min-w-0 items-center gap-2 text-sm font-medium">
                        <span className="truncate">{connection.name}</span>
                        {connection.isDefault ? (
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                            <Star className="size-3" aria-hidden="true" /> Default
                          </span>
                        ) : null}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {providerName(connection.provider)} · {isKey ? "API key" : "Sign-in"} ·{" "}
                        <span className={cn(connection.status === "connected" ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400")}>
                          {STATUS_LABEL[connection.status]}
                        </span>
                        {connection.ownership === "shared" ? " · Shared" : ""}
                      </p>
                      {connection.unavailableReason ? <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{connection.unavailableReason}</p> : null}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {isKey ? (
                      <Button type="button" variant="outline" size="sm" onClick={() => void copyKey(connection)} data-testid="api-key-copy">
                        {copied === connection.id ? <Check className="text-emerald-500" /> : <Copy />}
                        {copied === connection.id ? "Copied" : "Copy key"}
                      </Button>
                    ) : null}
                    {!connection.isDefault ? (
                      <Button type="button" variant="ghost" size="sm" disabled={makeDefault.isPending} onClick={() => makeDefault.mutate(connection.grantId)}>
                        <Star /> Make default
                      </Button>
                    ) : null}
                    <span className="flex-1" />
                    <Button
                      type="button"
                      variant={confirmRemove === connection.id ? "destructive" : "ghost"}
                      size="sm"
                      disabled={remove.isPending}
                      onClick={() => {
                        if (confirmRemove !== connection.id) {
                          haptic("tick");
                          setConfirmRemove(connection.id);
                          return;
                        }
                        remove.mutate(connection.id);
                      }}
                      data-testid="api-key-remove"
                    >
                      {remove.isPending && confirmRemove === connection.id ? <Loader2 className="animate-spin" /> : <Trash2 />}
                      {confirmRemove === connection.id ? "Tap again to remove" : "Remove"}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-label="Add a key" className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">Add a key</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Provider">
          {PROVIDERS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={provider === item.id}
              onClick={() => {
                haptic("tick");
                setProvider(item.id);
              }}
              className={cn(
                "flex min-h-12 items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                provider === item.id ? "border-primary bg-primary/10 font-medium" : "border-border hover:bg-accent",
              )}
              data-testid={`api-key-provider-${item.id}`}
            >
              <ModelLogo provider={item.brand} size="sm" />
              <span className="truncate">{item.name}</span>
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {info.hint}{" "}
          <a href={info.keyUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-2">
            Get a {info.name} key <ExternalLink className="size-3" aria-hidden="true" />
          </a>
        </p>
        <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1">
            <Input
              type={showKey ? "text" : "password"}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-label={`${info.name} API key`}
              placeholder={info.placeholder}
              value={keyInput}
              onChange={(event) => setKeyInput(event.target.value)}
              className="h-11 pr-11 font-mono text-sm"
              data-testid="api-key-input"
            />
            <button
              type="button"
              aria-label={showKey ? "Hide the key" : "Show the key"}
              onClick={() => setShowKey((current) => !current)}
              className="absolute top-1/2 right-1 flex size-9 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {showKey ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
            </button>
          </div>
          <Button type="submit" className="h-11 sm:h-11" disabled={!keyInput.trim() || add.isPending} data-testid="api-key-save">
            {add.isPending ? <Loader2 className="animate-spin" /> : <KeyRound />}
            {add.isPending ? "Checking…" : "Save key"}
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">Automa checks the key with the provider before saving it, so a typo shows up here, not in a failed run.</p>
      </section>
    </div>
  );
}
