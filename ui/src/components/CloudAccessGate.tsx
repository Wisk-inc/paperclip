import { useState } from "react";
import { Navigate, Outlet, useLocation, useNavigate } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import { authApi } from "@/api/auth";
import { healthApi } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";
import { BootstrapPendingPage } from "@/components/BootstrapPendingPage";
import { PaperclipLoading } from "@/components/AnimatedPaperclipIcon";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useSignOut } from "@/hooks/useSignOut";
import { inviteTargetFromInput } from "@/lib/invite-link";
import { isReachabilityError, reconnectRetryDelay, retryWhileUnreachable } from "@/lib/connection-recovery";

/**
 * Shown while the server can't be reached (offline, or Automa restarting),
 * instead of the browser's bare "Failed to fetch" that stayed until the app
 * was reopened. The checks behind it keep going by themselves.
 */
function ReconnectingNotice({ message, onRetry }: { message: string | null; onRetry: () => void }) {
  return (
    <div className="mx-auto max-w-xl py-10">
      <Card className="block p-6" role="status" aria-live="polite">
        <h1 className="text-xl font-semibold">Reconnecting to Automa…</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {message ?? "Automa isn't answering right now."} This page comes back by itself as soon as it answers; nothing
          is lost.
        </p>
        <Button className="mt-4" variant="outline" onClick={onRetry}>
          Try now
        </Button>
      </Card>
    </div>
  );
}

/** A query still trying after failing to reach the server, with nothing to show yet. */
function stillReconnecting(query: { isPending: boolean; failureCount: number; failureReason: unknown }): boolean {
  return query.isPending && query.failureCount > 0 && isReachabilityError(query.failureReason);
}

function NoBoardAccessPage() {
  const navigate = useNavigate();
  const signOut = useSignOut();
  const [inviteLink, setInviteLink] = useState("");
  const [inviteError, setInviteError] = useState<string | null>(null);

  return (
    <div className="mx-auto max-w-xl py-10">
      <Card className="block p-6">
        <h1 className="text-xl font-semibold">No organization access</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This account is signed in, but it does not have an active organization membership or instance-admin access on
          this Automa instance.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Use an organization invite or sign in with an account that already belongs to this org.
        </p>
        <form
          className="mt-4 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            const target = inviteTargetFromInput(inviteLink, window.location.origin);
            if (!target.ok) {
              setInviteError(target.message);
              return;
            }
            navigate(target.path);
          }}
        >
          <label htmlFor="no-access-invite-link" className="block text-sm font-medium">
            Have an invite link?
          </label>
          <div className="flex gap-2">
            <input
              id="no-access-invite-link"
              className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
              placeholder="Paste it here"
              value={inviteLink}
              onChange={(event) => {
                setInviteLink(event.target.value);
                setInviteError(null);
              }}
              aria-invalid={inviteError ? true : undefined}
              aria-describedby={inviteError ? "no-access-invite-error" : undefined}
            />
            <Button type="submit">Open</Button>
          </div>
          {inviteError ? (
            <p id="no-access-invite-error" role="alert" className="text-sm text-destructive">
              {inviteError}
            </p>
          ) : null}
        </form>
        <Button variant="outline" className="mt-4" disabled={signOut.isPending} onClick={() => signOut.mutate()}>
          {signOut.isPending ? "Signing out…" : "Sign in with another account"}
        </Button>
      </Card>
    </div>
  );
}

export function CloudAccessGate({ allowMembershipRequest = false }: { allowMembershipRequest?: boolean } = {}) {
  const location = useLocation();
  const queryClient = useQueryClient();
  // The sign-in page sends a signed-in person straight back, so switching
  // account means signing out first.
  const switchAccount = useSignOut();
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    // Asked again while the server can't be reached; a real answer is final.
    retry: retryWhileUnreachable,
    retryDelay: reconnectRetryDelay,
    refetchInterval: (query) => {
      const data = query.state.data as
        | { deploymentMode?: "local_trusted" | "authenticated"; bootstrapStatus?: "ready" | "bootstrap_pending" }
        | undefined;
      return data?.deploymentMode === "authenticated" && data.bootstrapStatus === "bootstrap_pending"
        ? 2000
        : false;
    },
    refetchIntervalInBackground: true,
  });

  const isAuthenticatedMode = healthQuery.data?.deploymentMode === "authenticated";
  const isBootstrapPending = isAuthenticatedMode && healthQuery.data?.bootstrapStatus === "bootstrap_pending";
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: isAuthenticatedMode,
    // A dropped connection is not "signed out": it is asked again, and the
    // sign-in page only follows a real answer.
    retry: retryWhileUnreachable,
    retryDelay: reconnectRetryDelay,
  });

  const boardAccessQuery = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    enabled: isAuthenticatedMode && !isBootstrapPending && !!sessionQuery.data,
    retry: retryWhileUnreachable,
    retryDelay: reconnectRetryDelay,
  });
  const claimMutation = useMutation({
    mutationFn: () => accessApi.claimBootstrapAdmin(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.health });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.stats });
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.currentBoardAccess });
    },
  });

  const reconnecting = [healthQuery, isAuthenticatedMode ? sessionQuery : null, boardAccessQuery].find(
    (query) => query !== null && stillReconnecting(query),
  );
  if (reconnecting) {
    const reason = reconnecting.failureReason;
    return (
      <ReconnectingNotice
        // Never the browser's own words ("Failed to fetch"): what it means.
        message={reason instanceof ApiError && reason.status >= 500 ? "Automa answered that it isn't ready yet." : null}
        onRetry={() => void reconnecting.refetch()}
      />
    );
  }

  if (
    healthQuery.isLoading ||
    (isAuthenticatedMode && sessionQuery.isLoading) ||
    (isAuthenticatedMode && !isBootstrapPending && !!sessionQuery.data && boardAccessQuery.isLoading)
  ) {
    return <PaperclipLoading />;
  }

  // The server can't be reached right now. That is no error page: the health
  // check is shared with the rest of the board, and when one of its re-checks
  // gave up during an outage, the whole board turned into one red line
  // ("Failed to fetch") that stayed until the app was reopened. With what the
  // board already has, it stays on screen (ConnectionRecovery asks again the
  // moment the server answers); with nothing yet, the reconnect card shows.
  const unreachable = (query: { error: unknown }) => query.error != null && isReachabilityError(query.error);
  if ((unreachable(healthQuery) && !healthQuery.data) || (unreachable(boardAccessQuery) && !boardAccessQuery.data)) {
    return (
      <ReconnectingNotice
        message={null}
        onRetry={() => {
          void healthQuery.refetch();
          if (boardAccessQuery.error) void boardAccessQuery.refetch();
        }}
      />
    );
  }
  const healthError = unreachable(healthQuery) ? null : healthQuery.error;
  const boardAccessError = unreachable(boardAccessQuery) ? null : boardAccessQuery.error;
  if (healthError || boardAccessError) {
    return (
      <div className="mx-auto max-w-xl py-10 text-sm text-destructive">
        {healthError instanceof Error
          ? healthError.message
          : boardAccessError instanceof Error
            ? boardAccessError.message
            : "Failed to load app state"}
      </div>
    );
  }

  if (isBootstrapPending) {
    const health = healthQuery.data;
    if (!health) {
      return <PaperclipLoading />;
    }
    const claimError = claimMutation.error instanceof ApiError
      ? { status: claimMutation.error.status, message: claimMutation.error.message }
      : claimMutation.error instanceof Error
        ? { message: claimMutation.error.message }
        : null;
    return (
      <BootstrapPendingPage
        claimAvailable={health.deploymentExposure === "private"}
        hasActiveInvite={health.bootstrapInviteActive}
        session={sessionQuery.data}
        claimState={claimMutation.isSuccess ? "success" : claimMutation.isPending ? "claiming" : "idle"}
        claimError={claimError}
        onClaim={() => claimMutation.mutate()}
        onSwitchAccount={() => switchAccount.mutate()}
      />
    );
  }

  if (isAuthenticatedMode && !sessionQuery.data) {
    // Not answered yet (the connection dropped): wait, rather than sign out.
    if (sessionQuery.error && isReachabilityError(sessionQuery.error)) {
      return <ReconnectingNotice message={null} onRetry={() => void sessionQuery.refetch()} />;
    }
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/auth?next=${next}`} replace />;
  }

  // Private invitation pages may let signed-in nonmembers request access.
  // Their token APIs still enforce membership before granting any authority.
  if (
    !allowMembershipRequest &&
    isAuthenticatedMode &&
    sessionQuery.data &&
    !boardAccessQuery.data?.isInstanceAdmin &&
    (boardAccessQuery.data?.companyIds.length ?? 0) === 0
  ) {
    return <NoBoardAccessPage />;
  }

  return <Outlet />;
}
