import { useEffect, useRef, useState, type FormEvent } from "react";
import { Download, FolderPlus, LoaderCircle, Paperclip, Send, X } from "lucide-react";
import type { StudioMessage } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatBytes } from "@/lib/issue-output";
import { haptic } from "@/lib/haptics";
import { cn } from "@/lib/utils";

interface StudioChatProps {
  messages: StudioMessage[];
  /** Messages from this side line up on the right. */
  me: { type: "owner" } | { type: "guest"; collaboratorId: string };
  onSend: (body: string, file: File | null) => Promise<void>;
  fileUrl: (attachmentId: string) => string;
  /** Owner only: copy a shared file into the project. */
  onAddToProject?: (attachmentId: string) => Promise<void>;
}

function isMine(message: StudioMessage, me: StudioChatProps["me"]) {
  if (me.type === "owner") return message.authorType === "owner";
  return message.authorType === "guest" && message.collaboratorId === me.collaboratorId;
}

/** Live chat for everyone in a shared project, with files passed back and forth. */
export function StudioChat({ messages, me, onSend, fileUrl, onAddToProject }: StudioChatProps) {
  const [body, setBody] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!body.trim() && !file) return;
    setSending(true);
    setError(null);
    try {
      await onSend(body.trim(), file);
      haptic("tick");
      setBody("");
      setFile(null);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Couldn't send");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-3" data-testid="studio-chat-log">
        {messages.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Say hi, or share a file with everyone in this project.</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {messages.map((message) =>
              message.authorType === "system" ? (
                <li key={message.id} className="text-center text-xs text-muted-foreground">
                  {message.body}
                </li>
              ) : (
                <li key={message.id} className={cn("flex max-w-(--sz-85pct) flex-col gap-0.5", isMine(message, me) ? "self-end items-end" : "self-start")}>
                  {!isMine(message, me) ? <span className="px-1 text-xs text-muted-foreground">{message.authorName}</span> : null}
                  <div
                    className={cn(
                      "rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words",
                      isMine(message, me) ? "rounded-br-md bg-primary text-primary-foreground" : "rounded-bl-md bg-muted",
                    )}
                  >
                    {message.body}
                    {message.attachment ? (
                      <div className={cn("mt-1 flex items-center gap-2 rounded-lg border px-2 py-1.5", isMine(message, me) ? "border-primary-foreground/30" : "border-border bg-background")}>
                        <Paperclip className="size-3.5 shrink-0" />
                        <span className="min-w-0 flex-1 truncate text-xs font-medium">{message.attachment.name}</span>
                        <span className="shrink-0 text-xs opacity-70">{formatBytes(message.attachment.size)}</span>
                        <a href={fileUrl(message.attachment.id)} download={message.attachment.name} aria-label={`Download ${message.attachment.name}`} className="shrink-0">
                          <Download className="size-3.5" />
                        </a>
                        {onAddToProject ? (
                          <button type="button" aria-label={`Add ${message.attachment.name} to the project`} onClick={() => void onAddToProject(message.attachment!.id)} className="shrink-0">
                            <FolderPlus className="size-3.5" />
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </li>
              ),
            )}
          </ol>
        )}
      </div>
      <form onSubmit={submit} className="flex flex-col gap-1 border-t border-border p-2">
        {error ? <p className="px-1 text-xs text-destructive">{error}</p> : null}
        {file ? (
          <div className="flex items-center gap-2 rounded-md bg-muted px-2 py-1 text-xs">
            <Paperclip className="size-3.5" />
            <span className="min-w-0 flex-1 truncate">{file.name}</span>
            <button type="button" aria-label="Remove file" onClick={() => setFile(null)}>
              <X className="size-3.5" />
            </button>
          </div>
        ) : null}
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Attach a file" onClick={() => fileRef.current?.click()}>
            <Paperclip />
          </Button>
          <input
            ref={fileRef}
            type="file"
            hidden
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              event.target.value = "";
            }}
          />
          <Input value={body} onChange={(event) => setBody(event.target.value)} placeholder="Message everyone" aria-label="Chat message" className="h-9 text-sm" />
          <Button type="submit" size="icon-sm" disabled={sending || (!body.trim() && !file)} aria-label="Send message">
            {sending ? <LoaderCircle className="animate-spin" /> : <Send />}
          </Button>
        </div>
      </form>
    </div>
  );
}
