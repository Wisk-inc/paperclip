import { createContext, type ReactNode } from "react";
import type { TaskChatMessageItem } from "./task-chat-model";

export interface HeldActionsContextValue {
  /** The newest agent message; its actions show inline, everyone else's hide. */
  latestAgentMessageId: string | null;
  /** Full action row for any message, shown in its press-and-hold menu. */
  renderHeldActions?: (item: TaskChatMessageItem) => ReactNode;
  /** Sends a message in this chat as the person, e.g. to ask for a picture again. */
  sendMessage?: (text: string) => Promise<void> | void;
}

/** Lets a bubble decide whether to show its action row inline or on hold. */
export const HeldActionsContext = createContext<HeldActionsContextValue>({ latestAgentMessageId: null });
