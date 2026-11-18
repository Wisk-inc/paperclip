import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gift, Loader2 } from "lucide-react";
import { freeModelsApi } from "@/api/free-models";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useToastActions } from "@/context/ToastContext";
import { haptic } from "@/lib/haptics";
import { formatLocale } from "@/i18n/format-locale";

const smallUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumSignificantDigits: 2 });
const wholeUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usd = (value: number) => (value > 0 && value < 0.01 ? smallUsd : wholeUsd).format(value);

/**
 * Free-model usage on the Costs and Home pages: tokens and images spent at $0,
 * what the same work would have cost at paid prices, and a reset. Renders
 * nothing until free models have actually been used, so it stays out of the way.
 */
export function FreeModelsSavingsCard({ companyId, className }: { companyId: string; className?: string }) {
  const client = useQueryClient();
  const { pushToast } = useToastActions();
  const usage = useQuery({
    queryKey: queryKeys.freeModels.usage(companyId),
    queryFn: () => freeModelsApi.usage(companyId),
  });
  const reset = useMutation({
    mutationFn: () => freeModelsApi.resetUsage(companyId),
    onSuccess: (data) => {
      haptic("success");
      client.setQueryData(queryKeys.freeModels.usage(companyId), data);
      pushToast({ title: "Free usage reset", tone: "success" });
    },
    onError: (error) => {
      haptic("warning");
      pushToast({ title: "Couldn’t reset free usage", body: error instanceof Error ? error.message : String(error), tone: "error" });
    },
  });

  const data = usage.data;
  if (!data) return null;
  const tokens = data.inputTokens + data.outputTokens;
  if (tokens === 0 && data.images === 0) return null;
  const locale = formatLocale();

  return (
    <Card className={className}>
      <div className="flex items-center gap-4 p-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-600">
          <Gift className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-(length:--text-micro) uppercase tracking-(--tracking-eyebrow) text-muted-foreground">Free models</div>
          <div className="mt-1 text-xl font-semibold tabular-nums">{usd(data.equivalentUsd)} <span className="text-sm font-normal text-muted-foreground">saved</span></div>
          {/* Phrase by phrase, each whole in its own element with its value as a piece of its own,
              so the board shows each in the person's language and a date keeps its own order in a
              right-to-left one. Glued into one line, the images and the date stayed in English and an
              Arabic date came apart. */}
          <div className="mt-0.5 text-xs text-muted-foreground" data-testid="free-models-usage">
            <span>{tokens.toLocaleString(locale)} tokens</span>
            {data.images ? (
              <>
                {" · "}
                {data.images === 1 ? <span>1 image</span> : <span>{data.images.toLocaleString(locale)} images</span>}
              </>
            ) : null}
            {" · "}
            <span>$0.00 charged</span>
            {data.since ? (
              <>
                {" · "}
                <span>since {new Date(data.since).toLocaleDateString(locale)}</span>
              </>
            ) : null}
          </div>
        </div>
        <Button variant="outline" size="sm" disabled={reset.isPending} onClick={() => reset.mutate()}>
          {reset.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          Reset
        </Button>
      </div>
    </Card>
  );
}
