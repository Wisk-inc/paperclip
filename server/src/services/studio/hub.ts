import { randomUUID } from "node:crypto";
import type { StudioClientEvent, StudioParticipant, StudioServerEvent } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { onStudioRuntimeCreated, type StudioRuntime } from "./runner.js";

export interface StudioHubSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}

interface HubClient {
  clientId: string;
  workspaceId: string;
  socket: StudioHubSocket;
  participant: StudioParticipant;
  /** Set for collaborators who joined with a code. */
  collaboratorId: string | null;
  /** Files whose live typing was too large to share; told once each. */
  refusedDrafts: Set<string>;
  /** The page is in front of the person (it says when it is hidden). */
  visible: boolean;
}

interface Draft {
  path: string;
  text: string;
  by: StudioParticipant;
}

const OPEN = 1;
const MAX_DRAFT_CHARS = 2_000_000;
/** Everyone's live typing in one project together, so nobody with the code can fill the server's memory. */
const MAX_PROJECT_DRAFT_CHARS = 8_000_000;
const MAX_PROJECT_DRAFTS = 200;
const MAX_DRAFT_PATH_CHARS = 1024;

/** A path short enough to name in a message. */
function shortPath(path: string) {
  return path.length > 120 ? `${path.slice(0, 120)}…` : path;
}

export const STUDIO_GUEST_COLORS = ["#E8590C", "#2F9E44", "#1971C2", "#9C36B5", "#C2255C", "#0C8599", "#E67700", "#5F3DC4"];
export const STUDIO_OWNER_COLOR = "#7048E8";

/**
 * Live collaboration for Studio projects: who is in each project, what they
 * are typing (drafts), and every change to files, the console, the running
 * app, and the chat.
 */
class StudioHub {
  private rooms = new Map<string, Set<HubClient>>();
  private drafts = new Map<string, Map<string, Draft>>();

  constructor() {
    onStudioRuntimeCreated((runtime) => this.attachRuntime(runtime));
  }

  private attachRuntime(runtime: StudioRuntime) {
    runtime.on("console", (lines) => this.broadcast(runtime.workspaceId, { type: "console", lines }));
    runtime.on("console:clear", () => this.broadcast(runtime.workspaceId, { type: "console:clear" }));
    runtime.on("state", (state) => this.broadcast(runtime.workspaceId, { type: "run", state }));
  }

  participants(workspaceId: string): StudioParticipant[] {
    const byId = new Map<string, StudioParticipant>();
    for (const client of this.rooms.get(workspaceId) ?? []) byId.set(client.participant.id, client.participant);
    return [...byId.values()];
  }

  /** Current drafts other people are typing in this project. */
  draftsFor(workspaceId: string): Draft[] {
    return [...(this.drafts.get(workspaceId)?.values() ?? [])];
  }

  broadcast(workspaceId: string, event: StudioServerEvent, exceptParticipantId?: string) {
    const payload = JSON.stringify(event);
    for (const client of this.rooms.get(workspaceId) ?? []) {
      if (exceptParticipantId && client.participant.id === exceptParticipantId) continue;
      if (client.socket.readyState === OPEN) client.socket.send(payload);
    }
  }

  /** Sends to the owner's open App Studio pages only (never guests); returns how many got it. */
  sendToOwners(workspaceId: string, event: StudioServerEvent): number {
    const payload = JSON.stringify(event);
    let sent = 0;
    for (const client of this.rooms.get(workspaceId) ?? []) {
      if (client.participant.role !== "owner" || client.socket.readyState !== OPEN) continue;
      client.socket.send(payload);
      sent += 1;
    }
    return sent;
  }

  /** True while the owner has this project on screen somewhere: then a finished reply needs no phone notification. */
  ownerWatching(workspaceId: string): boolean {
    for (const client of this.rooms.get(workspaceId) ?? []) {
      if (client.participant.role === "owner" && client.visible && client.socket.readyState === OPEN) return true;
    }
    return false;
  }

  private send(client: HubClient, event: StudioServerEvent) {
    if (client.socket.readyState === OPEN) client.socket.send(JSON.stringify(event));
  }

  join(input: { workspaceId: string; socket: StudioHubSocket; participant: Omit<StudioParticipant, "online" | "activePath">; collaboratorId?: string | null }) {
    const client: HubClient = {
      clientId: randomUUID(),
      workspaceId: input.workspaceId,
      socket: input.socket,
      participant: { ...input.participant, online: true, activePath: null },
      collaboratorId: input.collaboratorId ?? null,
      refusedDrafts: new Set(),
      visible: true,
    };
    let room = this.rooms.get(input.workspaceId);
    if (!room) {
      room = new Set();
      this.rooms.set(input.workspaceId, room);
    }
    room.add(client);
    this.send(client, { type: "hello", you: client.participant, participants: this.participants(input.workspaceId) });
    for (const draft of this.draftsFor(input.workspaceId)) {
      if (draft.by.id !== client.participant.id) this.send(client, { type: "draft", path: draft.path, text: draft.text, by: draft.by });
    }
    this.broadcast(input.workspaceId, { type: "presence", participants: this.participants(input.workspaceId) });

    input.socket.on("message", (data) => {
      try {
        const event = JSON.parse(String(data)) as StudioClientEvent;
        this.handle(client, event);
      } catch (error) {
        logger.debug({ error }, "ignored a malformed studio socket message");
      }
    });
    const leave = () => this.leave(client);
    input.socket.on("close", leave);
    input.socket.on("error", leave);
    return client.clientId;
  }

  private handle(client: HubClient, event: StudioClientEvent) {
    const { workspaceId, participant } = client;
    if (event.type === "draft" && typeof event.path === "string" && typeof event.text === "string") {
      const drafts = this.drafts.get(workspaceId) ?? new Map<string, Draft>();
      const key = `${participant.id}:${event.path}`;
      const previous = drafts.get(key);
      let used = 0;
      for (const draft of drafts.values()) if (draft !== previous) used += draft.path.length + draft.text.length;
      if (
        event.path.length > MAX_DRAFT_PATH_CHARS ||
        event.text.length > MAX_DRAFT_CHARS ||
        used + event.path.length + event.text.length > MAX_PROJECT_DRAFT_CHARS ||
        (!previous && drafts.size >= MAX_PROJECT_DRAFTS)
      ) {
        this.refuseDraft(client, event.path);
        return;
      }
      client.refusedDrafts.delete(shortPath(event.path));
      this.drafts.set(workspaceId, drafts);
      drafts.set(key, { path: event.path, text: event.text, by: participant });
      participant.activePath = event.path;
      this.broadcast(workspaceId, { type: "draft", path: event.path, text: event.text, by: participant }, participant.id);
    } else if (event.type === "draft:clear" && typeof event.path === "string") {
      client.refusedDrafts.delete(shortPath(event.path));
      this.drafts.get(workspaceId)?.delete(`${participant.id}:${event.path}`);
      this.broadcast(workspaceId, { type: "draft:clear", path: event.path, byId: participant.id }, participant.id);
    } else if (event.type === "visibility" && typeof event.visible === "boolean") {
      client.visible = event.visible;
    } else if (event.type === "focus") {
      participant.activePath = typeof event.path === "string" ? event.path : null;
      for (const other of this.rooms.get(workspaceId) ?? []) {
        if (other.participant.id === participant.id) other.participant.activePath = participant.activePath;
      }
      this.broadcast(workspaceId, { type: "presence", participants: this.participants(workspaceId) });
    }
  }

  /** Tells only the person typing (once per file, for a few files) that the others can't see it live. */
  private refuseDraft(client: HubClient, path: string) {
    const shown = shortPath(path);
    if (client.refusedDrafts.has(shown) || client.refusedDrafts.size >= 20) return;
    client.refusedDrafts.add(shown);
    this.send(client, {
      type: "chat",
      message: {
        id: randomUUID(),
        workspaceId: client.workspaceId,
        authorType: "system",
        authorName: "Automa",
        collaboratorId: null,
        body: `Your typing in ${shown} isn't shown to the others live: it is over the limit (about 2 MB a file, and 8 MB or 200 files for everyone's typing together). Save it or propose it as a change to share it.`,
        attachment: null,
        createdAt: new Date().toISOString(),
      },
    });
  }

  private leave(client: HubClient) {
    const room = this.rooms.get(client.workspaceId);
    if (!room?.delete(client)) return;
    const stillHere = [...room].some((other) => other.participant.id === client.participant.id);
    if (!stillHere) {
      const drafts = this.drafts.get(client.workspaceId);
      for (const key of [...(drafts?.keys() ?? [])]) {
        if (key.startsWith(`${client.participant.id}:`)) {
          const path = key.slice(client.participant.id.length + 1);
          drafts!.delete(key);
          this.broadcast(client.workspaceId, { type: "draft:clear", path, byId: client.participant.id });
        }
      }
    }
    if (room.size === 0) this.rooms.delete(client.workspaceId);
    this.broadcast(client.workspaceId, { type: "presence", participants: this.participants(client.workspaceId) });
  }

  /** Disconnects collaborators (one, or all of them) from a project. */
  kickGuests(workspaceId: string, reason: string, collaboratorId?: string) {
    for (const client of [...(this.rooms.get(workspaceId) ?? [])]) {
      if (!client.collaboratorId) continue;
      if (collaboratorId && client.collaboratorId !== collaboratorId) continue;
      this.send(client, { type: "kicked", reason });
      client.socket.close(4001, "removed");
      this.leave(client);
    }
  }
}

export const studioHub = new StudioHub();
