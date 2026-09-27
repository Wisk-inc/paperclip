import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Download,
  File as FileIcon,
  FileArchive,
  FileText,
  Film,
  FolderOpen,
  Globe,
  Image as ImageIcon,
  Monitor,
  MoreHorizontal,
  Music,
  Share2,
  Smartphone,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { CompanyDevice, DeviceFile, DeviceFileRequest } from "@paperclipai/shared";
import { deviceFilesApi } from "../api/deviceFiles";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { useThisDevice } from "../hooks/useThisDevice";
import { automaNative, isAutomaApp, type AutomaIncomingShare } from "../lib/automa-native";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { formatBytes } from "../lib/issue-output";
import { cn } from "../lib/utils";
import { Link, useSearchParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";

type Tab = "requests" | "files" | "devices";

function fileIconFor(contentType: string) {
  if (contentType.startsWith("image/")) return ImageIcon;
  if (contentType.startsWith("video/")) return Film;
  if (contentType.startsWith("audio/")) return Music;
  if (contentType.includes("zip") || contentType.includes("compressed")) return FileArchive;
  if (contentType.startsWith("text/") || contentType.includes("pdf") || contentType.includes("document")) return FileText;
  return FileIcon;
}

function platformIconFor(device: CompanyDevice) {
  if (device.platform === "android" || device.platform === "ios") return Smartphone;
  if (device.platform === "desktop") return Monitor;
  return Globe;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong";
}

/** A quiet section label, the same recipe everywhere on the page. */
function SectionLabel({ children }: { children: ReactNode }) {
  return <h2 className="text-sm font-medium text-muted-foreground">{children}</h2>;
}

export function DeviceFiles() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: Tab = (["requests", "files", "devices"] as const).includes(searchParams.get("tab") as Tab)
    ? (searchParams.get("tab") as Tab)
    : "requests";
  const inApp = isAutomaApp();
  const thisDevice = useThisDevice(selectedCompanyId);
  const sendInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Files" }]);
  }, [setBreadcrumbs]);

  const companyId = selectedCompanyId ?? "";
  const overview = useQuery({
    queryKey: queryKeys.deviceFiles.overview(companyId),
    queryFn: () => deviceFilesApi.overview(companyId),
    enabled: !!selectedCompanyId,
  });
  const requests = useQuery({
    queryKey: queryKeys.deviceFiles.requests(companyId),
    queryFn: () => deviceFilesApi.listRequests(companyId),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });
  const files = useQuery({
    queryKey: queryKeys.deviceFiles.files(companyId),
    queryFn: () => deviceFilesApi.listFiles(companyId),
    enabled: !!selectedCompanyId,
  });
  const agents = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!selectedCompanyId,
  });

  const agentName = useMemo(() => {
    const map = new Map((agents.data ?? []).map((agent) => [agent.id, agent.name]));
    return (id: string | null) => (id ? map.get(id) ?? "An agent" : null);
  }, [agents.data]);
  const devices = overview.data?.devices ?? [];
  const deviceName = useMemo(() => {
    const map = new Map(devices.map((device) => [device.id, device.name]));
    return (id: string | null) => (id ? map.get(id) ?? "a removed device" : null);
  }, [devices]);

  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: ["device-files", companyId] });
  };

  const upload = useMutation({
    mutationFn: async (input: { files: File[] }) => {
      for (const file of input.files) {
        await deviceFilesApi.uploadFile(companyId, {
          file,
          filename: file.name,
          sourceDeviceId: thisDevice.deviceId,
        });
      }
      return input.files.length;
    },
    onSuccess: (count) => {
      pushToast({ title: count === 1 ? "File sent to your agents" : `${count} files sent to your agents`, tone: "success" });
      refreshAll();
      setSearchParams((params) => {
        params.set("tab", "files");
        return params;
      });
    },
    onError: (error) => pushToast({ title: "Upload failed", body: errorMessage(error), tone: "error" }),
  });

  const onPickToSend = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (picked.length > 0) upload.mutate({ files: picked });
  };

  const pendingRequests = (requests.data ?? []).filter((request) => request.status === "pending");
  const resolvedRequests = (requests.data ?? []).filter((request) => request.status !== "pending").slice(0, 20);

  if (!selectedCompanyId) return <PageSkeleton variant="list" />;

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: "requests", label: "Requests", count: pendingRequests.length },
    { key: "files", label: "Files", count: files.data?.length },
    { key: "devices", label: "Devices", count: devices.length },
  ];

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 pb-28 md:pb-8">
      <ThisDevicePanel
        inApp={inApp}
        device={thisDevice.device}
        deviceId={thisDevice.deviceId}
        registering={thisDevice.register.isPending}
        registerError={thisDevice.register.error}
        onRegister={() => thisDevice.register.mutate()}
        onDeviceChange={(next) => {
          thisDevice.setDevice(next);
          refreshAll();
        }}
      />

      {inApp && thisDevice.deviceId ? (
        <IncomingShares companyId={companyId} deviceId={thisDevice.deviceId} onDone={refreshAll} />
      ) : null}

      <div className="space-y-4">
        <div role="tablist" aria-label="File views" className="flex gap-1 border-b border-border">
          {tabs.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              onClick={() =>
                setSearchParams((params) => {
                  params.set("tab", item.key);
                  return params;
                })
              }
              className={cn(
                "-mb-px flex h-11 items-center gap-2 border-b-2 px-3 text-sm transition-colors duration-150",
                tab === item.key
                  ? "border-foreground font-semibold text-foreground"
                  : "border-transparent font-medium text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
              {item.count ? (
                <span
                  className={cn(
                    "rounded-md px-1.5 text-xs tabular-nums",
                    item.key === "requests" ? "bg-foreground text-background" : "bg-muted text-muted-foreground",
                  )}
                >
                  {item.count}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        {tab === "requests" ? (
          <RequestsView
            loading={requests.isLoading}
            pending={pendingRequests}
            resolved={resolvedRequests}
            agentName={agentName}
            deviceName={deviceName}
            thisDeviceId={thisDevice.deviceId}
            onChanged={refreshAll}
          />
        ) : tab === "files" ? (
          <FilesView
            loading={files.isLoading}
            files={files.data ?? []}
            thisDeviceId={thisDevice.deviceId}
            agentName={agentName}
            deviceName={deviceName}
            onChanged={refreshAll}
            onSend={() => sendInputRef.current?.click()}
          />
        ) : (
          <DevicesView
            devices={devices}
            thisDeviceId={thisDevice.deviceId}
            onChanged={(removedId) => {
              if (removedId && removedId === thisDevice.deviceId) thisDevice.forget();
              refreshAll();
            }}
          />
        )}
      </div>

      {/* The one primary action on this page lives in the thumb zone on
          phones (just above the tab bar) and inline on wider screens. */}
      <input ref={sendInputRef} type="file" multiple className="hidden" onChange={onPickToSend} />
      <div className="fixed inset-x-0 bottom-(--sz-calc-14) z-20 border-t border-border bg-background px-4 py-3 md:static md:border-0 md:bg-transparent md:p-0">
        <Button
          className="h-12 w-full text-base md:h-10 md:w-auto md:text-sm"
          onClick={() => sendInputRef.current?.click()}
          disabled={upload.isPending}
        >
          <Upload className="h-4 w-4" />
          {upload.isPending ? "Sending…" : "Send a file to your agents"}
        </Button>
      </div>
    </div>
  );
}

function ThisDevicePanel({
  inApp,
  device,
  deviceId,
  registering,
  registerError,
  onRegister,
  onDeviceChange,
}: {
  inApp: boolean;
  device: CompanyDevice | null;
  deviceId: string | null;
  registering: boolean;
  registerError: unknown;
  onRegister: () => void;
  onDeviceChange: (device: CompanyDevice) => void;
}) {
  const { pushToast } = useToastActions();
  const [folder, setFolder] = useState(() => automaNative.sharedFolder());
  const [syncing, setSyncing] = useState(false);

  async function shareFolder() {
    if (!deviceId) return;
    setSyncing(true);
    try {
      await automaNative.pickSharedFolder();
      const listing = await automaNative.listSharedFolder();
      const updated = await deviceFilesApi.reportSharedIndex(deviceId, {
        sharedFolderName: listing.name,
        entries: listing.entries,
      });
      setFolder({ name: listing.name });
      onDeviceChange(updated);
      pushToast({
        title: `Sharing ${listing.name}`,
        body: `${listing.entries.length} file${listing.entries.length === 1 ? "" : "s"} visible to your agents${listing.truncated ? " (list truncated)" : ""}.`,
        tone: "success",
      });
    } catch (error) {
      pushToast({ title: "Folder not shared", body: errorMessage(error), tone: "warn" });
    } finally {
      setSyncing(false);
    }
  }

  async function stopSharing() {
    if (!deviceId) return;
    automaNative.clearSharedFolder();
    setFolder(null);
    try {
      onDeviceChange(await deviceFilesApi.reportSharedIndex(deviceId, { sharedFolderName: null, entries: [] }));
    } catch (error) {
      pushToast({ title: "Could not update sharing", body: errorMessage(error), tone: "error" });
    }
  }

  async function setAutoSend(next: boolean) {
    if (!deviceId) return;
    try {
      onDeviceChange(await deviceFilesApi.updateDevice(deviceId, { autoFulfill: next }));
    } catch (error) {
      pushToast({ title: "Could not change auto-send", body: errorMessage(error), tone: "error" });
    }
  }

  if (!deviceId) {
    return (
      <section className="rounded-lg border border-border bg-card p-4">
        <p className="font-display text-lg font-semibold tracking-tight">Connect this {inApp ? "phone" : "browser"}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Registering lets your agents ask this {inApp ? "phone" : "browser"} for files and send files back to it.
          You approve every request unless you share a folder and turn on auto-send.
        </p>
        {registerError ? <p className="mt-2 text-sm text-destructive">{errorMessage(registerError)}</p> : null}
        <Button className="mt-4 h-11 w-full sm:w-auto" onClick={onRegister} disabled={registering}>
          <Smartphone className="h-4 w-4" />
          {registering ? "Connecting…" : `Connect this ${inApp ? "phone" : "browser"}`}
        </Button>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-3 p-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted">
          <Smartphone className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{device?.name ?? "This device"}</p>
          <p className="text-sm text-muted-foreground">Connected · agents can reach this {inApp ? "phone" : "browser"}</p>
        </div>
      </div>
      <div className="border-t border-border p-4">
        {inApp ? (
          folder || device?.sharedFolderName ? (
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <FolderOpen className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">Sharing “{folder?.name ?? device?.sharedFolderName}”</p>
                  <p className="text-sm text-muted-foreground">
                    {device?.sharedIndexCount ?? 0} files listed for agents
                    {device?.sharedIndexUpdatedAt ? ` · updated ${timeAgo(device.sharedIndexUpdatedAt)}` : ""}
                  </p>
                </div>
              </div>
              <label className="flex items-center justify-between gap-4">
                <span className="text-sm">
                  <span className="block font-medium">Auto-send requested files</span>
                  <span className="block text-muted-foreground">Agents get files from this folder without asking you each time.</span>
                </span>
                <ToggleSwitch checked={Boolean(device?.autoFulfill)} onCheckedChange={(next) => void setAutoSend(next)} aria-label="Auto-send requested files" />
              </label>
              <div className="flex gap-2">
                <Button variant="outline" className="h-11 flex-1" onClick={() => void shareFolder()} disabled={syncing}>
                  {syncing ? "Reading folder…" : "Change folder"}
                </Button>
                <Button variant="ghost" className="h-11" onClick={() => void stopSharing()}>
                  Stop sharing
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Share one folder so agents can see its files and pull the ones they need. Nothing outside that folder is visible.
              </p>
              <Button variant="outline" className="h-11 w-full" onClick={() => void shareFolder()} disabled={syncing}>
                <FolderOpen className="h-4 w-4" />
                {syncing ? "Reading folder…" : "Share a folder"}
              </Button>
            </div>
          )
        ) : (
          <p className="text-sm text-muted-foreground">
            Answer requests and send files from this browser. To let agents browse a folder on your phone, install the Automa Android app.
          </p>
        )}
      </div>
    </section>
  );
}

function IncomingShares({ companyId, deviceId, onDone }: { companyId: string; deviceId: string; onDone: () => void }) {
  const { pushToast } = useToastActions();
  const [shares, setShares] = useState<AutomaIncomingShare[]>(() => automaNative.incomingShares());
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const refresh = () => setShares(automaNative.incomingShares());
    window.addEventListener("automa:incoming-shares", refresh);
    return () => window.removeEventListener("automa:incoming-shares", refresh);
  }, []);

  if (shares.length === 0) return null;

  async function sendAll() {
    setSending(true);
    try {
      for (const share of shares) {
        const res = await fetch(share.url, { cache: "no-store" });
        if (!res.ok) throw new Error(`Could not read ${share.name}`);
        await deviceFilesApi.uploadFile(companyId, { file: await res.blob(), filename: share.name, sourceDeviceId: deviceId });
      }
      pushToast({ title: shares.length === 1 ? "Shared file sent" : `${shares.length} shared files sent`, tone: "success" });
      automaNative.clearIncomingShares();
      setShares([]);
      onDone();
    } catch (error) {
      pushToast({ title: "Could not send shared files", body: errorMessage(error), tone: "error" });
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="rounded-lg border border-foreground/20 bg-card p-4">
      <div className="flex items-center gap-2">
        <Share2 className="h-4 w-4" />
        <p className="font-medium">From your share sheet</p>
      </div>
      <ul className="mt-3 space-y-1 text-sm">
        {shares.map((share) => (
          <li key={share.id} className="flex justify-between gap-3">
            <span className="truncate">{share.name}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{share.byteSize != null ? formatBytes(share.byteSize) : ""}</span>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex gap-2">
        <Button className="h-11 flex-1" onClick={() => void sendAll()} disabled={sending}>
          {sending ? "Sending…" : `Send ${shares.length === 1 ? "it" : `all ${shares.length}`} to your agents`}
        </Button>
        <Button
          variant="ghost"
          className="h-11"
          onClick={() => {
            automaNative.clearIncomingShares();
            setShares([]);
          }}
        >
          Discard
        </Button>
      </div>
    </section>
  );
}

function RequestsView({
  loading,
  pending,
  resolved,
  agentName,
  deviceName,
  thisDeviceId,
  onChanged,
}: {
  loading: boolean;
  pending: DeviceFileRequest[];
  resolved: DeviceFileRequest[];
  agentName: (id: string | null) => string | null;
  deviceName: (id: string | null) => string | null;
  thisDeviceId: string | null;
  onChanged: () => void;
}) {
  if (loading) return <PageSkeleton variant="list" />;
  if (pending.length === 0 && resolved.length === 0) {
    return (
      <EmptyState
        icon={FolderOpen}
        title="No file requests yet"
        message="When an agent needs a file from your phone or computer, it asks here. You pick the file, or it arrives automatically from a folder you share."
      />
    );
  }
  return (
    <div className="space-y-6">
      {pending.length > 0 ? (
        <div className="space-y-3">
          <SectionLabel>Waiting on you</SectionLabel>
          <ul className="space-y-3">
            {pending.map((request) => (
              <RequestCard
                key={request.id}
                request={request}
                agentName={agentName}
                deviceName={deviceName}
                thisDeviceId={thisDeviceId}
                onChanged={onChanged}
              />
            ))}
          </ul>
        </div>
      ) : (
        <p className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
          Nothing is waiting on you. New requests from agents show up here.
        </p>
      )}
      {resolved.length > 0 ? (
        <div className="space-y-2">
          <SectionLabel>Earlier</SectionLabel>
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {resolved.map((request) => (
              <li key={request.id} className="flex items-center gap-3 px-4 py-3">
                {request.status === "fulfilled" ? (
                  <Check className="h-4 w-4 shrink-0 text-(--status-task-done)" aria-label="Sent" />
                ) : (
                  <X className="h-4 w-4 shrink-0 text-muted-foreground" aria-label={request.status} />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{request.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {request.status === "fulfilled" ? "Sent" : request.status === "declined" ? "Declined" : "Cancelled"}
                    {request.resolvedAt ? ` ${timeAgo(request.resolvedAt)}` : ""}
                    {request.requestedByAgentId ? ` · ${agentName(request.requestedByAgentId)}` : ""}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function RequestCard({
  request,
  agentName,
  deviceName,
  thisDeviceId,
  onChanged,
}: {
  request: DeviceFileRequest;
  agentName: (id: string | null) => string | null;
  deviceName: (id: string | null) => string | null;
  thisDeviceId: string | null;
  onChanged: () => void;
}) {
  const { pushToast } = useToastActions();
  const inputRef = useRef<HTMLInputElement>(null);
  const inShared = Boolean(request.devicePath && automaNative.sharedFolder());
  const forOtherDevice = Boolean(request.deviceId && thisDeviceId && request.deviceId !== thisDeviceId);

  const fulfill = useMutation({
    mutationFn: async (input: { file: Blob; filename: string; devicePath?: string | null }) =>
      deviceFilesApi.fulfillRequest(request.id, {
        file: input.file,
        filename: input.filename,
        deviceId: thisDeviceId,
        devicePath: input.devicePath ?? null,
      }),
    onSuccess: () => {
      pushToast({ title: "Sent", body: `${agentName(request.requestedByAgentId) ?? "The requester"} has the file now.`, tone: "success" });
      onChanged();
    },
    onError: (error) => pushToast({ title: "Could not send the file", body: errorMessage(error), tone: "error" }),
  });
  const decline = useMutation({
    mutationFn: () => deviceFilesApi.declineRequest(request.id, { deviceId: thisDeviceId }),
    onSuccess: onChanged,
    onError: (error) => pushToast({ title: "Could not decline", body: errorMessage(error), tone: "error" }),
  });

  const requester = request.requestedByAgentId ? agentName(request.requestedByAgentId) : "A board member";
  const busy = fulfill.isPending || decline.isPending;

  return (
    <li className="rounded-lg border border-border bg-card p-4">
      <p className="font-medium leading-snug">{request.title}</p>
      <p className="mt-1 text-sm text-muted-foreground">
        {requester} asked {timeAgo(request.createdAt)}
        {request.deviceId ? ` · for ${deviceName(request.deviceId)}` : " · any device"}
      </p>
      {request.details ? <p className="mt-3 text-sm leading-relaxed">{request.details}</p> : null}
      {request.devicePath ? (
        <p className="mt-2 truncate rounded-md bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">{request.devicePath}</p>
      ) : null}
      {request.issueId ? (
        <Link to={`/issues/${request.issueId}`} className="mt-2 inline-block text-sm underline underline-offset-4">
          Open the task
        </Link>
      ) : null}
      {forOtherDevice ? (
        <p className="mt-3 text-sm text-muted-foreground">Addressed to another device.</p>
      ) : (
        <div className="mt-4 flex gap-2">
          <input
            ref={inputRef}
            type="file"
            className="hidden"
            accept={request.acceptTypes ?? undefined}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) fulfill.mutate({ file, filename: file.name });
            }}
          />
          {inShared && request.devicePath ? (
            <Button
              className="h-11 flex-1"
              disabled={busy}
              onClick={async () => {
                try {
                  const blob = await automaNative.readSharedFile(request.devicePath!);
                  fulfill.mutate({ file: blob, filename: request.devicePath!.split("/").pop()!, devicePath: request.devicePath });
                } catch (error) {
                  pushToast({ title: "Could not read the file", body: errorMessage(error), tone: "error" });
                }
              }}
            >
              <Upload className="h-4 w-4" />
              Send from shared folder
            </Button>
          ) : null}
          <Button
            variant={inShared ? "outline" : "default"}
            className="h-11 flex-1"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            {fulfill.isPending ? "Sending…" : inShared ? "Pick another" : "Choose file"}
          </Button>
          <Button variant="ghost" className="h-11" disabled={busy} onClick={() => decline.mutate()}>
            Decline
          </Button>
        </div>
      )}
    </li>
  );
}

function FilesView({
  loading,
  files,
  thisDeviceId,
  agentName,
  deviceName,
  onChanged,
  onSend,
}: {
  loading: boolean;
  files: DeviceFile[];
  thisDeviceId: string | null;
  agentName: (id: string | null) => string | null;
  deviceName: (id: string | null) => string | null;
  onChanged: () => void;
  onSend: () => void;
}) {
  const { pushToast } = useToastActions();
  const remove = useMutation({
    mutationFn: (fileId: string) => deviceFilesApi.deleteFile(fileId),
    onSuccess: onChanged,
    onError: (error) => pushToast({ title: "Could not delete", body: errorMessage(error), tone: "error" }),
  });

  if (loading) return <PageSkeleton variant="list" />;
  if (files.length === 0) {
    return (
      <EmptyState
        icon={Upload}
        title="No files yet"
        message="Files you send from this device, and files agents send back to you, collect here."
        action="Send a file"
        onAction={onSend}
        hideActionIcon
      />
    );
  }

  const toThisDevice = files.filter((file) => thisDeviceId && file.targetDeviceId === thisDeviceId);
  const rest = files.filter((file) => !(thisDeviceId && file.targetDeviceId === thisDeviceId));

  const origin = (file: DeviceFile) => {
    if (file.sourceDeviceId) return `from ${deviceName(file.sourceDeviceId)}`;
    if (file.uploadedByAgentId) {
      const target = file.targetDeviceId ? ` → ${deviceName(file.targetDeviceId)}` : "";
      return `from ${agentName(file.uploadedByAgentId)}${target}`;
    }
    return "uploaded from the board";
  };

  const renderList = (list: DeviceFile[]) => (
    <ul className="divide-y divide-border rounded-lg border border-border bg-card">
      {list.map((file) => {
        const Icon = fileIconFor(file.contentType);
        return (
          <li key={file.id} className="flex items-center gap-3 pl-4 pr-2">
            <a
              href={deviceFilesApi.contentUrl(file.id)}
              target="_blank"
              rel="noreferrer"
              className="flex min-w-0 flex-1 items-center gap-3 py-3 text-inherit no-underline"
            >
              <Icon className="h-5 w-5 shrink-0 text-muted-foreground" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{file.filename}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {formatBytes(file.byteSize)} · {origin(file)} · {timeAgo(file.createdAt)}
                </span>
              </span>
            </a>
            <a
              href={deviceFilesApi.contentUrl(file.id, { download: true })}
              download={file.filename}
              aria-label={`Save ${file.filename} to this device`}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Download className="h-4 w-4" />
            </a>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`More actions for ${file.filename}`}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  className="text-destructive"
                  onSelect={() => {
                    if (window.confirm(`Delete ${file.filename}? Agents will no longer be able to download it.`)) {
                      remove.mutate(file.id);
                    }
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="space-y-6">
      {toThisDevice.length > 0 ? (
        <div className="space-y-2">
          <SectionLabel>Sent to this device</SectionLabel>
          {renderList(toThisDevice)}
        </div>
      ) : null}
      <div className="space-y-2">
        {toThisDevice.length > 0 ? <SectionLabel>All files</SectionLabel> : null}
        {renderList(rest)}
      </div>
    </div>
  );
}

function DevicesView({
  devices,
  thisDeviceId,
  onChanged,
}: {
  devices: CompanyDevice[];
  thisDeviceId: string | null;
  onChanged: (removedId?: string) => void;
}) {
  const { pushToast } = useToastActions();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  const rename = useMutation({
    mutationFn: (input: { id: string; name: string }) => deviceFilesApi.updateDevice(input.id, { name: input.name }),
    onSuccess: () => {
      setEditingId(null);
      onChanged();
    },
    onError: (error) => pushToast({ title: "Could not rename", body: errorMessage(error), tone: "error" }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deviceFilesApi.removeDevice(id),
    onSuccess: (_result, id) => onChanged(id),
    onError: (error) => pushToast({ title: "Could not remove", body: errorMessage(error), tone: "error" }),
  });

  if (devices.length === 0) {
    return (
      <EmptyState
        icon={Smartphone}
        title="No devices connected"
        message="Connect a phone or browser above so agents can reach it."
      />
    );
  }

  return (
    <ul className="divide-y divide-border rounded-lg border border-border bg-card">
      {devices.map((device) => {
        const Icon = platformIconFor(device);
        const isThis = device.id === thisDeviceId;
        return (
          <li key={device.id} className="flex items-center gap-3 pl-4 pr-2">
            <Icon className="h-5 w-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1 py-3">
              {editingId === device.id ? (
                <form
                  className="flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const name = draftName.trim();
                    if (name) rename.mutate({ id: device.id, name });
                  }}
                >
                  <Input value={draftName} onChange={(event) => setDraftName(event.target.value)} autoFocus aria-label="Device name" />
                  <Button type="submit" size="sm" disabled={rename.isPending || !draftName.trim()}>
                    Save
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                    Cancel
                  </Button>
                </form>
              ) : (
                <>
                  <p className="flex items-center gap-2 truncate text-sm font-medium">
                    {device.name}
                    {isThis ? <span className="rounded-md bg-muted px-1.5 text-xs font-medium text-muted-foreground">This device</span> : null}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {device.lastSeenAt ? `Seen ${timeAgo(device.lastSeenAt)}` : "Not seen yet"}
                    {device.sharedFolderName ? ` · sharing “${device.sharedFolderName}” (${device.sharedIndexCount})` : ""}
                    {device.autoFulfill ? " · auto-send on" : ""}
                  </p>
                </>
              )}
            </div>
            {editingId !== device.id ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={`Actions for ${device.name}`}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onSelect={() => {
                      setDraftName(device.name);
                      setEditingId(device.id);
                    }}
                  >
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-destructive"
                    onSelect={() => {
                      if (window.confirm(`Remove ${device.name}? Agents will stop sending requests to it.`)) remove.mutate(device.id);
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                    Remove
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
