import type { ServerInfoSnapshot } from "@paperclipai/shared";
import { tenantSessionRecovery } from "@/lib/tenant-session-recovery";
import { ApiError, fetchApi } from "./client";

export type DevServerHealthStatus = {
  enabled: true;
  restartRequired: boolean;
  reason: "backend_changes" | "pending_migrations" | "backend_changes_and_pending_migrations" | null;
  lastChangedAt: string | null;
  changedPathCount: number;
  changedPathsSample: string[];
  pendingMigrations: string[];
  autoRestartEnabled: boolean;
  activeRunCount: number;
  waitingForIdle: boolean;
  lastRestartAt: string | null;
};

export type CloudInstanceHealthStatus = {
  managed: true;
  managedBy: "paperclip-cloud";
  stackSlug: string | null;
  stackDisplayName?: string;
  cloudBaseUrl: string | null;
};

/** What a starting server says it is doing (server/src/startup-recovery-state.ts). */
export type StartupProgress = {
  phase: "starting" | "recovering";
  /** Whole seconds since the server began starting. */
  seconds: number;
  step: { id: string; label: string; seconds: number; number?: number; total?: number } | null;
};

export type HealthStatus = {
  /** "starting" until the server's startup recovery is done; it serves requests meanwhile. */
  status: "ok" | "starting";
  /** Present while status is "starting" (Automa 1.9.10 on). */
  startup?: StartupProgress;
  version?: string;
  deploymentMode?: "local_trusted" | "authenticated";
  /** A local instance locked to the Automa app (PAPERCLIP_LOCAL_TRUSTED_SECRET); other local clients are anonymous. */
  localSecretRequired?: boolean;
  deploymentExposure?: "private" | "public";
  localAiLoginSupported?: boolean;
  authReady?: boolean;
  bootstrapStatus?: "ready" | "bootstrap_pending";
  bootstrapInviteActive?: boolean;
  features?: {
    companyDeletionEnabled?: boolean;
    /** False when this server does not let people create accounts (invite only). */
    signUpEnabled?: boolean;
    /** The server accepts "Continue with Google" from the Automa Android app. */
    firebaseSignIn?: boolean;
  };
  serverInfo?: ServerInfoSnapshot;
  devServer?: DevServerHealthStatus;
  cloud?: CloudInstanceHealthStatus;
  /**
   * Settings surfaces hidden by the hosting operator (keys from the shared
   * settings-visibility registry). Absent when nothing is hidden.
   */
  hiddenSettings?: string[];
  /**
   * Automa started in safe mode (server/src/safe-mode.ts, Automa 1.9.12 on):
   * the board works, while agents, schedules and plugins wait for a normal start.
   */
  safeMode?: boolean;
  /** Why: it kept stopping while it started, or someone asked for a safe start. */
  safeModeReason?: "crashes" | "asked";
  /** Whether "Restart normally" works here (the automa launcher started this server). */
  safeModeRestartAvailable?: boolean;
};

/** What each refusal of "Restart normally" means, in words. */
const RESTART_NORMALLY_ERRORS: Record<string, string> = {
  instance_admin_required: "Only the owner of this Automa can restart it.",
  not_in_safe_mode: "Automa is not in safe mode any more.",
  not_started_by_automa: "This Automa wasn't started by the automa command, so nothing would start it again. In Termux, stop it and run: automa start",
};

export const healthApi = {
  get: async (): Promise<HealthStatus> => {
    const res = await fetchApi("/api/health", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => null) as { error?: string } | null;
      const recovery = tenantSessionRecovery.recoverIfNeeded(res.status, payload);
      if (recovery) return recovery;
      // With its status, so a server that is restarting (5xx) is asked again.
      throw new ApiError(payload?.error ?? `Failed to load health (${res.status})`, res.status, payload);
    }
    return res.json();
  },
  /** Safe mode's "Restart normally": the server stops, and the automa launcher starts it again, normally. */
  restartNormally: async (): Promise<void> => {
    const res = await fetchApi("/api/health/safe-mode/restart", {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => null) as { error?: string } | null;
      const code = payload?.error ?? "";
      throw new ApiError(RESTART_NORMALLY_ERRORS[code] ?? `Couldn't restart Automa (${res.status})`, res.status, payload);
    }
  },
  requestDevServerRestart: async (): Promise<void> => {
    const res = await fetchApi("/api/health/dev-server/restart", {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => null) as { error?: string } | null;
      const recovery = tenantSessionRecovery.recoverIfNeeded(res.status, payload);
      if (recovery) return recovery;
      throw new Error(payload?.error ?? `Failed to request restart (${res.status})`);
    }
  },
};
