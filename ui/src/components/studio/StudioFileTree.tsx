import { useMemo, useRef, useState, type FormEvent } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  Ellipsis,
  File,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Trash2,
  Upload,
} from "lucide-react";
import type { StudioFileNode, StudioParticipant } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

interface StudioFileTreeProps {
  tree: StudioFileNode[];
  activePath: string | null;
  onOpen: (path: string) => void;
  /** Paths with unsaved or proposed edits (shown with a dot). */
  editedPaths?: ReadonlySet<string>;
  /** Paths hidden while their delete can still be undone. */
  hiddenPaths?: ReadonlySet<string>;
  /** Who else has each file open. */
  participants?: StudioParticipant[];
  onCreate?: (path: string, type: "file" | "folder") => Promise<void> | void;
  onRename?: (from: string, to: string) => Promise<void> | void;
  onDelete?: (path: string) => void;
  onUpload?: (files: File[], folder: string | null) => Promise<void> | void;
  downloadUrl?: (path: string) => string;
}

type Draft = { kind: "create"; type: "file" | "folder"; folder: string | null } | { kind: "rename"; path: string };

function parentOf(path: string): string | null {
  const index = path.lastIndexOf("/");
  return index === -1 ? null : path.slice(0, index);
}

/**
 * The project's files and folders. Tap a file to open it; folders fold.
 * Each row's menu renames, downloads, or deletes; the header makes new files
 * and folders and uploads files from this device.
 */
export function StudioFileTree({
  tree,
  activePath,
  onOpen,
  editedPaths,
  hiddenPaths,
  participants = [],
  onCreate,
  onRename,
  onDelete,
  onUpload,
  downloadUrl,
}: StudioFileTreeProps) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftName, setDraftName] = useState("");
  const [busy, setBusy] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const uploadFolder = useRef<string | null>(null);

  const viewers = useMemo(() => {
    const map = new Map<string, StudioParticipant[]>();
    for (const participant of participants) {
      if (!participant.activePath) continue;
      map.set(participant.activePath, [...(map.get(participant.activePath) ?? []), participant]);
    }
    return map;
  }, [participants]);

  const toggle = (path: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const startCreate = (type: "file" | "folder", folder: string | null) => {
    if (folder) setOpen((current) => new Set(current).add(folder));
    setDraft({ kind: "create", type, folder });
    setDraftName("");
  };

  const submitDraft = async (event: FormEvent) => {
    event.preventDefault();
    const name = draftName.trim().replace(/^\/+/, "");
    if (!draft || !name) {
      setDraft(null);
      return;
    }
    setBusy(true);
    try {
      if (draft.kind === "create") {
        const path = draft.folder ? `${draft.folder}/${name}` : name;
        await onCreate?.(path, draft.type);
        if (draft.type === "file") onOpen(path);
      } else {
        const parent = parentOf(draft.path);
        const to = name.includes("/") ? name : parent ? `${parent}/${name}` : name;
        if (to !== draft.path) await onRename?.(draft.path, to);
      }
      setDraft(null);
    } finally {
      setBusy(false);
    }
  };

  const draftRow = (depth: number) => (
    <form onSubmit={submitDraft} className="flex items-center gap-1 py-0.5 pr-2" style={{ paddingLeft: `calc(var(--spacing) * ${2 + depth * 4})` }}>
      {draft?.kind === "create" && draft.type === "folder" ? <Folder className="size-4 shrink-0 text-muted-foreground" /> : <File className="size-4 shrink-0 text-muted-foreground" />}
      <Input
        autoFocus
        value={draftName}
        disabled={busy}
        onChange={(event) => setDraftName(event.target.value)}
        onBlur={() => {
          if (!draftName.trim()) setDraft(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") setDraft(null);
        }}
        placeholder={draft?.kind === "create" ? (draft.type === "folder" ? "folder name" : "file name, e.g. app.py") : "new name"}
        aria-label={draft?.kind === "create" ? `New ${draft.type} name` : "New name"}
        className="h-8 font-mono text-sm"
      />
    </form>
  );

  const renderNodes = (nodes: StudioFileNode[], depth: number, folder: string | null): React.ReactNode[] => {
    const rows: React.ReactNode[] = [];
    if (draft?.kind === "create" && draft.folder === folder) rows.push(<li key={`draft:${folder ?? ""}`}>{draftRow(depth)}</li>);
    for (const node of nodes) {
      if (hiddenPaths?.has(node.path)) continue;
      const isFolder = node.type === "folder";
      const isOpen = open.has(node.path);
      const here = viewers.get(node.path) ?? [];
      if (draft?.kind === "rename" && draft.path === node.path) {
        rows.push(<li key={node.path}>{draftRow(depth)}</li>);
        continue;
      }
      rows.push(
        <li key={node.path}>
          <div
            className={cn(
              "group flex items-center rounded-md pr-1 text-sm",
              activePath === node.path ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
            )}
          >
            <button
              type="button"
              onClick={() => (isFolder ? toggle(node.path) : onOpen(node.path))}
              className="flex min-h-9 min-w-0 flex-1 items-center gap-1.5 py-1 text-left pointer-coarse:min-h-10"
              style={{ paddingLeft: `calc(var(--spacing) * ${2 + depth * 4})` }}
              data-testid={`studio-tree-${node.path}`}
            >
              {isFolder ? (
                <>
                  {isOpen ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
                  {isOpen ? <FolderOpen className="size-4 shrink-0 text-muted-foreground" /> : <Folder className="size-4 shrink-0 text-muted-foreground" />}
                </>
              ) : (
                <File className="ml-5 size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate font-mono text-(length:--text-compact)">{node.name}</span>
              {editedPaths?.has(node.path) ? <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="edited" /> : null}
              {here.length ? (
                <span className="ml-auto flex shrink-0 -space-x-1 pl-1">
                  {here.slice(0, 3).map((participant) => (
                    <span
                      key={participant.id}
                      title={`${participant.name} is here`}
                      className="size-2.5 rounded-full ring-2 ring-background"
                      style={{ backgroundColor: participant.color }}
                    />
                  ))}
                </span>
              ) : null}
            </button>
            {onCreate || onRename || onDelete || downloadUrl ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`More for ${node.name}`}
                    className="shrink-0 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100 md:data-[state=open]:opacity-100"
                  >
                    <Ellipsis />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {isFolder && onCreate ? (
                    <>
                      <DropdownMenuItem onSelect={() => startCreate("file", node.path)}>
                        <FilePlus /> New file here
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => startCreate("folder", node.path)}>
                        <FolderPlus /> New folder here
                      </DropdownMenuItem>
                    </>
                  ) : null}
                  {isFolder && onUpload ? (
                    <DropdownMenuItem
                      onSelect={() => {
                        uploadFolder.current = node.path;
                        uploadRef.current?.click();
                      }}
                    >
                      <Upload /> Upload here
                    </DropdownMenuItem>
                  ) : null}
                  {onRename ? (
                    <DropdownMenuItem
                      onSelect={() => {
                        setDraft({ kind: "rename", path: node.path });
                        setDraftName(node.name);
                      }}
                    >
                      <Pencil /> Rename
                    </DropdownMenuItem>
                  ) : null}
                  {!isFolder && downloadUrl ? (
                    <DropdownMenuItem asChild>
                      <a href={downloadUrl(node.path)} download={node.name}>
                        <Download /> Download
                      </a>
                    </DropdownMenuItem>
                  ) : null}
                  {onDelete ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onSelect={() => onDelete(node.path)}>
                        <Trash2 /> Delete
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
          {isFolder && isOpen ? <ul>{renderNodes(node.children ?? [], depth + 1, node.path)}</ul> : null}
        </li>,
      );
    }
    return rows;
  };

  const rows = renderNodes(tree, 0, null);
  return (
    <div className="flex h-full min-h-0 flex-col">
      {onCreate || onUpload ? (
        <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
          <span className="mr-auto text-xs font-medium uppercase tracking-wide text-muted-foreground">Files</span>
          {onCreate ? (
            <>
              <Button variant="ghost" size="icon-sm" aria-label="New file" title="New file" onClick={() => startCreate("file", null)}>
                <FilePlus />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label="New folder" title="New folder" onClick={() => startCreate("folder", null)}>
                <FolderPlus />
              </Button>
            </>
          ) : null}
          {onUpload ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Upload files"
              title="Upload files"
              onClick={() => {
                uploadFolder.current = null;
                uploadRef.current?.click();
              }}
            >
              <Upload />
            </Button>
          ) : null}
          <input
            ref={uploadRef}
            type="file"
            multiple
            hidden
            data-testid="studio-upload-input"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              if (files.length) void onUpload?.(files, uploadFolder.current);
            }}
          />
        </div>
      ) : null}
      <ul className="min-h-0 flex-1 overflow-y-auto p-1" aria-label="Project files">
        {rows.length ? rows : <li className="px-3 py-6 text-center text-sm text-muted-foreground">No files yet.</li>}
      </ul>
    </div>
  );
}
