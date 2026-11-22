import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";
import { freeModelOffline, resolveFreeModel, type FreeModelCheckResult, type FreeModelHealthMap } from "@paperclipai/shared";
import { freeModelsApi } from "@/api/free-models";
import { isServerTooOld, retryUnlessServerTooOld } from "@/components/device/PhoneServerOutdated";
import { Button } from "@/components/ui/button";
import { useToastActions } from "@/context/ToastContext";
import { haptic } from "@/lib/haptics";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

/** The health record of a free model as a picker lists it (Moan runs on another model's id). */
export function freeModelHealthOf(health: FreeModelHealthMap | undefined, modelId: string) {
  return health?.[resolveFreeModel(modelId).puterModel];
}

/** How many of the listed models are known not to answer. */
export function offlineCount(health: FreeModelHealthMap | undefined, models: readonly string[], now: number = Date.now()): number {
  return models.filter((id) => freeModelOffline(freeModelHealthOf(health, id), now)).length;
}

/**
 * One line about the free models' state, with a button that asks every one of
 * them for a word. A provider can take a free version offline for a day or a
 * month, and Automa never answers on another model than the one picked, so
 * this is how a person finds the ones that answer without trying each.
 * The answer fills the same health record the model lists read.
 */
export function FreeModelCheck({ models, className }: { models: readonly string[]; className?: string }) {
  const client = useQueryClient();
  const { pushToast } = useToastActions();
  const [result, setResult] = useState<FreeModelCheckResult | null>(null);
  const health = useQuery({
    queryKey: queryKeys.freeModels.health(),
    queryFn: () => freeModelsApi.health(),
    retry: retryUnlessServerTooOld,
    staleTime: 30_000,
  });
  const check = useMutation({
    mutationFn: () => freeModelsApi.checkHealth(),
    onSuccess: (found) => {
      haptic("tick");
      setResult(found);
      client.setQueryData<FreeModelHealthMap>(queryKeys.freeModels.health(), (old) => ({ ...(old ?? {}), ...found.health }));
    },
    onError: (error) => {
      haptic("warning");
      pushToast({
        title: "Couldn't check the free models",
        body: isServerTooOld(error)
          ? "Automa on this device is older than the app. Update it, then try again."
          : error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    },
  });

  // A server from before the health record has nothing to show or to ask.
  if (isServerTooOld(health.error)) return null;

  const offline = offlineCount(health.data, models);
  return (
    <div className={cn("flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-2", className)} data-testid="free-model-check">
      <p className="min-w-0 flex-1 text-xs text-muted-foreground" aria-live="polite">
        {check.isPending ? (
          "Asking each free model for one word. This takes about half a minute."
        ) : result ? (
          <>
            <span className="font-medium text-foreground">{result.answering} of {result.total}</span> free models answer right now. The others are marked in the lists.
          </>
        ) : offline > 0 ? (
          <>
            <span className="font-medium text-foreground">{offline}</span> of these free models did not answer when last asked.
          </>
        ) : (
          "Free models come and go at their providers. See which ones answer right now."
        )}
      </p>
      <Button
        size="sm"
        variant="outline"
        disabled={check.isPending}
        onClick={() => { haptic("tick"); check.mutate(); }}
        data-testid="free-model-check-start"
      >
        {check.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />} {result ? "Check again" : "Check"}
      </Button>
    </div>
  );
}
