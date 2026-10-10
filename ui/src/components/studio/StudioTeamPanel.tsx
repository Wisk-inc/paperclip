import { useMemo, useState } from "react";
import { ArrowLeft, Check, Copy, GitPullRequest, LoaderCircle, Pencil, Share2, UserMinus, Users, X } from "lucide-react";
import type { StudioChangeFile, StudioChangeRequest, StudioCollaborator, StudioMessage, StudioParticipant } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { haptic } from "@/lib/haptics";
import { timeAgo } from "@/lib/timeAgo";
import { cn } from "@/lib/utils";
import { Mascot } from "../mascot/Mascot";
import { CodeEditor } from "./CodeEditor";
import { StudioChat } from "./StudioChat";
import { StudioDiffView } from "./StudioDiffView";

export interface StudioShareInfo {
  code: string;
  inviteUrl: string | null;
  localInviteUrl: string;
  publicError: string | null;
}

interface StudioTeamPanelProps {
  shareEnabled: boolean;
  shareCode: string | null;
  /** When the code stops working (null: never). */
  shareExpiresAt: string | null;
  share: StudioShareInfo | null;
  participants: StudioParticipant[];
  collaborators: StudioCollaborator[];
  messages: StudioMessage[];
  changeRequests: StudioChangeRequest[];
  /** Turns sharing on or changes it (expiry in hours, null for none; a new code). */
  onShare: (options: { expiresInHours?: number | null; newCode?: boolean }) => Promise<void>;
  onStopSharing: () => Promise<void>;
  onRemoveCollaborator: (collaboratorId: string) => Promise<void>;
  onSendMessage: (body: string, file: File | null) => Promise<void>;
  fileUrl: (attachmentId: string) => string;
  onAddToProject: (attachmentId: string) => Promise<void>;
  onAccept: (changeId: string, files?: StudioChangeFile[]) => Promise<void>;
  onReject: (changeId: string) => Promise<void>;
}

type Section = "people" | "chat" | "changes";

const EXPIRY_OPTIONS: Array<{ label: string; hours: number | null }> = [
  { label: "1 hour", hours: 1 },
  { label: "1 day", hours: 24 },
  { label: "7 days", hours: 24 * 7 },
  { label: "30 days", hours: 24 * 30 },
  { label: "No limit", hours: null },
];

function expiryText(expiresAt: string | null) {
  if (!expiresAt) return "Works until you stop sharing";
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "Expired";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 55) return `Expires in ${Math.max(1, minutes)} min`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `Expires in ${hours} h`;
  return `Expires in ${Math.round(hours / 24)} days`;
}

function ExpiryPicker({ value, onChange, disabled }: { value: number | null; onChange: (hours: number | null) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">Code works for</span>
      <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="How long the code works">
        {EXPIRY_OPTIONS.map((option) => (
          <button
            key={option.label}
            type="button"
            role="radio"
            aria-checked={value === option.hours}
            disabled={disabled}
            onClick={() => onChange(option.hours)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-xs",
              value === option.hours ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background/60 text-muted-foreground hover:bg-accent",
            )}
            data-testid={`studio-expiry-${option.hours ?? "never"}`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function CopyField({ label, value, testId }: { label: string; value: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1">
        <span className="min-w-0 flex-1 truncate font-mono text-sm" data-testid={testId}>
          {value}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => {
              haptic("success");
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
    </div>
  );
}

function ChangeReview({
  change,
  onBack,
  onAccept,
  onReject,
}: {
  change: StudioChangeRequest;
  onBack: () => void;
  onAccept: (files?: StudioChangeFile[]) => Promise<void>;
  onReject: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState<StudioChangeFile[]>(change.files);
  const [busy, setBusy] = useState<"accept" | "reject" | null>(null);
  const open = change.status === "open";

  const run = async (kind: "accept" | "reject") => {
    setBusy(kind);
    try {
      if (kind === "accept") await onAccept(editing ? edited : undefined);
      else await onReject();
      onBack();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
        <Button variant="ghost" size="icon-sm" aria-label="Back to changes" onClick={onBack}>
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{change.authorName}'s changes</p>
          <p className="truncate text-xs text-muted-foreground">
            {change.files.length} {change.files.length === 1 ? "file" : "files"} · {timeAgo(change.createdAt)}
            {change.status !== "open" ? ` · ${change.status}` : ""}
          </p>
        </div>
        {open ? (
          <Button variant={editing ? "secondary" : "ghost"} size="sm" onClick={() => setEditing((value) => !value)}>
            <Pencil /> {editing ? "Diff" : "Edit"}
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {change.message ? <p className="mb-3 text-sm whitespace-pre-wrap">{change.message}</p> : null}
        {editing ? (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">Adjust their version before you accept it.</p>
            {edited.map((file, index) =>
              file.after === null ? (
                <p key={file.path} className="font-mono text-xs text-muted-foreground">
                  {file.path} will be deleted.
                </p>
              ) : (
                <div key={file.path} className="flex flex-col gap-1">
                  <span className="font-mono text-xs font-medium">{file.path}</span>
                  <div className="h-64 overflow-hidden rounded-lg border border-border">
                    <CodeEditor
                      path={file.path}
                      value={file.after}
                      onChange={(value) => setEdited((files) => files.map((item, i) => (i === index ? { ...item, after: value } : item)))}
                    />
                  </div>
                </div>
              ),
            )}
          </div>
        ) : (
          <StudioDiffView files={editing ? edited : change.files} />
        )}
      </div>
      {open ? (
        <div className="flex items-center gap-2 border-t border-border p-2">
          <Button variant="outline" className="flex-1" disabled={busy !== null} onClick={() => void run("reject")} data-testid="studio-change-reject">
            {busy === "reject" ? <LoaderCircle className="animate-spin" /> : <X />} Deny
          </Button>
          <Button className="flex-1" disabled={busy !== null} onClick={() => void run("accept")} data-testid="studio-change-accept">
            {busy === "accept" ? <LoaderCircle className="animate-spin" /> : <Check />} {editing ? "Accept edited" : "Accept"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Working together on a project: an invite code and link, who is here, the
 * team chat, and the changes collaborators submitted for you to review.
 */
export function StudioTeamPanel(props: StudioTeamPanelProps) {
  const openChanges = props.changeRequests.filter((change) => change.status === "open");
  const [section, setSection] = useState<Section>(() => (openChanges.length ? "changes" : "people"));
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [expiryHours, setExpiryHours] = useState<number | null>(24);
  const reviewing = useMemo(() => props.changeRequests.find((change) => change.id === reviewId) ?? null, [props.changeRequests, reviewId]);
  const guests = props.participants.filter((participant) => participant.role === "guest");

  if (reviewing) {
    return (
      <ChangeReview
        change={reviewing}
        onBack={() => setReviewId(null)}
        onAccept={(files) => props.onAccept(reviewing.id, files)}
        onReject={() => props.onReject(reviewing.id)}
      />
    );
  }

  const tabs: Array<{ id: Section; label: string; count?: number }> = [
    { id: "people", label: "People", count: guests.length || undefined },
    { id: "chat", label: "Chat" },
    { id: "changes", label: "Changes", count: openChanges.length || undefined },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex gap-1 border-b border-border p-1" role="tablist" aria-label="Team">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={section === tab.id}
            onClick={() => setSection(tab.id)}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-sm",
              section === tab.id ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-accent/50",
            )}
          >
            {tab.label}
            {tab.count ? <span className="rounded-full bg-primary px-1.5 text-(length:--text-micro) font-semibold text-primary-foreground">{tab.count}</span> : null}
          </button>
        ))}
      </div>

      {section === "people" ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className="flex flex-col gap-4">
            {props.shareEnabled && props.shareCode ? (
              <div className="flex flex-col gap-3 rounded-2xl border border-primary/40 bg-linear-to-br from-primary/15 to-card p-4" data-testid="studio-share-card">
                <div className="flex items-center gap-2">
                  <Share2 className="size-4 text-primary" />
                  <span className="text-sm font-medium">Sharing is on</span>
                </div>
                <div className="flex items-end justify-between gap-2">
                  <div className="flex flex-col gap-1">
                    <span className="text-xs text-muted-foreground">Join code</span>
                    <span className="font-mono text-2xl font-semibold tracking-widest" data-testid="studio-share-code">
                      {props.shareCode}
                    </span>
                  </div>
                  <span className="rounded-full bg-background/70 px-2 py-0.5 text-xs text-muted-foreground" data-testid="studio-share-expiry">
                    {expiryText(props.shareExpiresAt)}
                  </span>
                </div>
                {props.share?.inviteUrl ? <CopyField label="Invite link" value={props.share.inviteUrl} testId="studio-invite-link" /> : null}
                {props.share && !props.share.inviteUrl ? (
                  <>
                    <CopyField label="Invite link (this network)" value={props.share.localInviteUrl} testId="studio-invite-link" />
                    {props.share.publicError ? <p className="text-xs text-muted-foreground">No public link: {props.share.publicError}</p> : null}
                  </>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  People who join see your code as you type, chat with you, and send changes for you to accept. They can't save files or reach the rest of Automa.
                </p>
                <ExpiryPicker
                  value={expiryHours}
                  disabled={sharing}
                  onChange={(hours) => {
                    setExpiryHours(hours);
                    setSharing(true);
                    void props.onShare({ expiresInHours: hours }).finally(() => setSharing(false));
                  }}
                />
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={sharing}
                    onClick={() => {
                      setSharing(true);
                      void props.onShare({ newCode: true, expiresInHours: expiryHours }).finally(() => setSharing(false));
                    }}
                    data-testid="studio-new-code"
                  >
                    New code
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive"
                    disabled={sharing}
                    onClick={() => {
                      setSharing(true);
                      void props.onStopSharing().finally(() => setSharing(false));
                    }}
                    data-testid="studio-stop-sharing"
                  >
                    Revoke all
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">New code stops the old one from working; people already in stay. Revoke all ends sharing and removes everyone.</p>
              </div>
            ) : (
              <div className="flex flex-col items-start gap-3 rounded-2xl border border-border bg-linear-to-br from-primary/15 to-card p-4">
                <div className="flex items-center gap-3">
                  <Mascot pose="cheering" size="sm" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Users className="size-4 text-primary" />
                      <span className="text-sm font-semibold">Build together</span>
                    </div>
                    <p className="text-sm text-muted-foreground">Share a code or link. Friends see what you type live, chat, share files, and suggest changes you approve.</p>
                  </div>
                </div>
                <ExpiryPicker value={expiryHours} onChange={setExpiryHours} disabled={sharing} />
                <Button
                  disabled={sharing}
                  data-testid="studio-share-button"
                  onClick={() => {
                    setSharing(true);
                    void props.onShare({ expiresInHours: expiryHours }).finally(() => setSharing(false));
                  }}
                >
                  {sharing ? <LoaderCircle className="animate-spin" /> : <Share2 />} Invite people
                </Button>
              </div>
            )}

            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Here now</span>
              <ul className="flex flex-col gap-1">
                {props.participants.map((participant) => (
                  <li key={participant.id} className="flex items-center gap-2 text-sm">
                    <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: participant.color }} />
                    <span className="min-w-0 flex-1 truncate">
                      {participant.name}
                      {participant.role === "owner" ? <span className="text-muted-foreground"> (owner)</span> : null}
                    </span>
                    {participant.activePath ? <span className="max-w-32 truncate font-mono text-xs text-muted-foreground">{participant.activePath}</span> : null}
                  </li>
                ))}
              </ul>
            </div>

            {props.collaborators.filter((collaborator) => collaborator.status === "active").length ? (
              <div className="flex flex-col gap-2">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Collaborators</span>
                <ul className="flex flex-col gap-1">
                  {props.collaborators
                    .filter((collaborator) => collaborator.status === "active")
                    .map((collaborator) => (
                      <li key={collaborator.id} className="flex items-center gap-2 text-sm">
                        <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: collaborator.color }} />
                        <span className="min-w-0 flex-1 truncate">{collaborator.displayName}</span>
                        <Button variant="ghost" size="icon-xs" aria-label={`Remove ${collaborator.displayName}`} onClick={() => void props.onRemoveCollaborator(collaborator.id)}>
                          <UserMinus />
                        </Button>
                      </li>
                    ))}
                </ul>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {section === "chat" ? (
        <StudioChat messages={props.messages} me={{ type: "owner" }} onSend={props.onSendMessage} fileUrl={props.fileUrl} onAddToProject={props.onAddToProject} />
      ) : null}

      {section === "changes" ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {props.changeRequests.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">When a collaborator submits changes, they show up here for you to review.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {props.changeRequests.map((change) => (
                <li key={change.id}>
                  <button
                    type="button"
                    onClick={() => setReviewId(change.id)}
                    className="flex w-full items-center gap-3 rounded-lg border border-border p-3 text-left hover:bg-accent/50"
                    data-testid="studio-change-row"
                  >
                    <GitPullRequest className={cn("size-4 shrink-0", change.status === "open" ? "text-primary" : "text-muted-foreground")} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {change.authorName}: {change.files.map((file) => file.path).join(", ")}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {change.status === "open" ? "Waiting for you" : change.status === "accepted" ? "Accepted" : "Denied"} · {timeAgo(change.createdAt)}
                      </p>
                    </div>
                    {change.status === "open" ? <span className="text-xs font-medium text-primary">Review</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
