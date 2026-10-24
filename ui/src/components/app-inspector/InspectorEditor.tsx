import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { redo, undo } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import type { EditorView } from "@codemirror/view";
import { ArrowLeft, Loader2, Redo2, Save, Search, Sparkles, Undo2, X } from "lucide-react";
import { appInspectorApi, type InspectorFileContent, type InspectorView } from "@/api/app-inspector";
import { CodeEditor } from "@/components/studio/CodeEditor";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToastActions } from "@/context/ToastContext";
import { haptic } from "@/lib/haptics";
import { fileKind } from "./file-kinds";

/** Keys a phone keyboard hides, for smali, XML and Java (Apktool M's symbol bar). */
const SYMBOLS = ["\t", "{", "}", "(", ")", ";", ":", ".", ",", "/", '"', "=", "->", "<", ">", "#", "v0", "p0", "L", "[", "]"];

function symbolLabel(symbol: string) {
  return symbol === "\t" ? "Tab" : symbol;
}

/** A file from a decoded app, full screen: read, edit, find, save, and ask Claude. */
export function InspectorEditor({
  companyId,
  projectId,
  view,
  path,
  building,
  onClose,
}: {
  companyId: string;
  projectId: string;
  view: InspectorView;
  path: string;
  building: boolean;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const { pushToast } = useToastActions();
  const editorRef = useRef<EditorView | null>(null);
  const [draft, setDraft] = useState("");
  const [explanation, setExplanation] = useState<string | null>(null);
  const name = path.split("/").pop() ?? path;
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const kind = fileKind(name, false);

  const fileKey = ["inspector", "file", companyId, projectId, view, path];
  const file = useQuery({
    queryKey: fileKey,
    queryFn: () => appInspectorApi.file(companyId, projectId, path, view),
    enabled: !kind.image,
    // A background refetch (switching back to the app) would replace unsaved edits.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  useEffect(() => {
    if (file.data) setDraft(file.data.text);
  }, [file.data]);

  const editable = Boolean(file.data && !file.data.readOnly && !file.data.binary);
  const dirty = editable && file.data!.text !== draft;

  const save = useMutation({
    mutationFn: () => appInspectorApi.writeFile(companyId, projectId, path, draft),
    onSuccess: () => {
      haptic("success");
      client.setQueryData<InspectorFileContent>(fileKey, (old) => (old ? { ...old, text: draft } : old));
      pushToast({ title: "Saved", body: "Build the app to put the change into an APK.", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Couldn't save", body: error instanceof Error ? error.message : String(error), tone: "error" }),
  });
  const explain = useMutation({
    mutationFn: () => appInspectorApi.explain(companyId, projectId, path, view),
    onSuccess: ({ explanation: text }) => setExplanation(text),
    onError: (error) => pushToast({ title: "Claude couldn't read it", body: error instanceof Error ? error.message : String(error), tone: "error" }),
  });

  const close = () => {
    if (dirty && !window.confirm("Leave without saving your change?")) return;
    onClose();
  };
  const insert = (symbol: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    haptic("tick");
    editor.dispatch(editor.state.replaceSelection(symbol));
    editor.focus();
  };

  return (
    <div
      className="studio-ide-immersive fixed inset-0 z-50 flex flex-col bg-background pt-(--sz-safe-top) pb-(--sz-safe-bottom)"
      role="dialog"
      aria-label={`Editing ${name}`}
      data-testid="inspector-editor"
    >
      <header className="flex items-center gap-1 border-b border-border px-1 py-1.5">
        <Button variant="ghost" size="icon-sm" aria-label="Back to files" onClick={close}><ArrowLeft /></Button>
        <kind.icon className={`size-4 shrink-0 ${kind.tone}`} aria-hidden="true" />
        <span className="min-w-0 flex-1 px-1">
          <span className="block truncate text-sm font-semibold">{name}{dirty ? " •" : ""}</span>
          {folder ? <span className="block truncate font-mono text-xs text-muted-foreground">{folder}</span> : null}
        </span>
        {!kind.image && file.data && !file.data.binary ? (
          <>
            <Button variant="ghost" size="icon-sm" aria-label="Find in file" onClick={() => editorRef.current && openSearchPanel(editorRef.current)} data-testid="inspector-find">
              <Search />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Explain with Claude" disabled={explain.isPending} onClick={() => explain.mutate()} data-testid="inspector-explain">
              {explain.isPending ? <Loader2 className="animate-spin" /> : <Sparkles />}
            </Button>
          </>
        ) : null}
        {editable ? (
          <Button size="sm" disabled={!dirty || save.isPending || building} onClick={() => save.mutate()} data-testid="inspector-save">
            {save.isPending ? <Loader2 className="animate-spin" /> : <Save />} Save
          </Button>
        ) : null}
      </header>

      {file.data?.readOnly && !file.data.binary ? (
        <p className="border-b border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground">
          {view === "java"
            ? "Decompiled Java is for reading. To change the code, edit its smali in Files, then build."
            : "Larger than 2 MB: only the start is shown, and it can't be saved from here."}
        </p>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {kind.image ? (
          <div className="flex h-full items-center justify-center bg-(--terminal-surface) p-6">
            <img src={appInspectorApi.imageUrl(companyId, projectId, view, path)} alt={name} className="max-h-full max-w-full object-contain" data-testid="inspector-image" />
          </div>
        ) : file.isPending ? (
          <Skeleton className="m-3 h-(--sz-60vh)" />
        ) : file.isError ? (
          <p className="p-4 text-sm text-destructive">{file.error instanceof Error ? file.error.message : "Couldn't open that file"}</p>
        ) : file.data?.binary ? (
          <p className="p-4 text-sm text-muted-foreground" data-testid="inspector-binary">
            This is a binary file ({kind.label.toLowerCase()}), so it can't be shown as text. It goes back into the APK as it is when you build.
          </p>
        ) : (
          <CodeEditor
            path={path}
            value={draft}
            onChange={setDraft}
            readOnly={!editable}
            onSave={() => dirty && !building && save.mutate()}
            onReady={(editor) => {
              editorRef.current = editor;
            }}
            ariaLabel={`Code: ${name}`}
            className="h-full"
          />
        )}

        {explanation ? (
          <section
            className="absolute inset-x-2 bottom-2 flex max-h-(--sz-50vh) flex-col rounded-xl border border-border bg-card shadow-lg motion-safe:animate-in motion-safe:slide-in-from-bottom-2"
            aria-label="Claude's explanation"
            data-testid="inspector-explanation"
          >
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <Sparkles className="size-4 text-primary" aria-hidden="true" />
              <span className="flex-1 text-sm font-semibold">Claude</span>
              <Button variant="ghost" size="icon-sm" aria-label="Close the explanation" onClick={() => setExplanation(null)}><X /></Button>
            </div>
            <div className="overflow-y-auto px-3 py-2 text-sm whitespace-pre-wrap">{explanation}</div>
          </section>
        ) : null}
      </div>

      {editable ? (
        <div className="flex items-center gap-1 overflow-x-auto border-t border-border bg-card px-1 py-1" role="toolbar" aria-label="Symbols" data-testid="inspector-symbols">
          <Button variant="ghost" size="icon-sm" aria-label="Undo" onMouseDown={(event) => event.preventDefault()} onClick={() => editorRef.current && undo(editorRef.current)}><Undo2 /></Button>
          <Button variant="ghost" size="icon-sm" aria-label="Redo" onMouseDown={(event) => event.preventDefault()} onClick={() => editorRef.current && redo(editorRef.current)}><Redo2 /></Button>
          {SYMBOLS.map((symbol) => (
            <button
              key={symbol}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => insert(symbol)}
              className="flex h-9 min-w-9 shrink-0 items-center justify-center rounded-md px-2 font-mono text-sm text-foreground hover:bg-accent"
            >
              {symbolLabel(symbol)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
