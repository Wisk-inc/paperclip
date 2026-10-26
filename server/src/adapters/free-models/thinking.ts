export const FREE_THINKING_LEVELS = ["low", "medium", "high", "xhigh"] as const;
export type FreeThinkingLevel = (typeof FREE_THINKING_LEVELS)[number];

const INSTRUCTIONS: Record<FreeThinkingLevel, string> = {
  low: "Think briefly before you answer.",
  medium: "Think step by step before you answer.",
  high: "Think step by step carefully. Consider edge cases and check your work before you answer.",
  xhigh: "Think very carefully and at length. Break the problem down, weigh alternatives, verify every step, and double-check the final answer before you reply.",
};

export function readThinkingLevel(value: unknown): FreeThinkingLevel | null {
  return typeof value === "string" && (FREE_THINKING_LEVELS as readonly string[]).includes(value)
    ? (value as FreeThinkingLevel)
    : null;
}

/** Hidden system text for a level: how hard to think, and where to put the thinking so it can be shown. */
export function thinkingInstruction(level: FreeThinkingLevel): string {
  return `${INSTRUCTIONS[level]} Write your thinking inside <thinking></thinking> tags first, then give the final answer after the closing tag.`;
}

/** Splits a reply into its thinking and its answer; native reasoning wins when the model returned it separately. */
export function splitThinking(text: string, nativeReasoning: string): { thinking: string; answer: string } {
  const tagged = /<thinking>([\s\S]*?)<\/thinking>/i.exec(text);
  const answer = (tagged ? text.replace(tagged[0], "") : text).replace(/<\/?thinking>/gi, "").trim();
  const thinking = (nativeReasoning.trim() || tagged?.[1]?.trim() || "").trim();
  return { thinking, answer: answer || text.trim() };
}


export interface ThinkingPiece {
  channel: "text" | "thinking";
  text: string;
}

/**
 * Routes a streamed reply into answer text and thinking as it arrives, so a
 * model that writes its thinking inside <thinking></thinking> tags shows that
 * thinking in the collapsible panel (not in the reply) exactly like a model
 * that streams native reasoning. Tags may be split across deltas, so partial
 * tag text is held back until the tag completes.
 */
export function createThinkingTagSplitter() {
  let inside = false;
  let buffer = "";
  const OPEN = "<thinking>";
  const CLOSE = "</thinking>";

  // The longest tag prefix at the end of `text` that might still grow into a tag.
  function heldPrefix(text: string): number {
    const tag = inside ? CLOSE : OPEN;
    for (let length = Math.min(tag.length - 1, text.length); length > 0; length -= 1) {
      if (tag.startsWith(text.slice(text.length - length))) return length;
    }
    return 0;
  }

  function drain(final: boolean): ThinkingPiece[] {
    const pieces: ThinkingPiece[] = [];
    for (;;) {
      const tag = inside ? CLOSE : OPEN;
      const at = buffer.indexOf(tag);
      if (at === -1) break;
      const before = buffer.slice(0, at);
      if (before) pieces.push({ channel: inside ? "thinking" : "text", text: before });
      buffer = buffer.slice(at + tag.length);
      inside = !inside;
    }
    const hold = final ? 0 : heldPrefix(buffer);
    const emit = buffer.slice(0, buffer.length - hold);
    buffer = buffer.slice(buffer.length - hold);
    if (emit) pieces.push({ channel: inside ? "thinking" : "text", text: emit });
    return pieces;
  }

  return {
    push(delta: string): ThinkingPiece[] {
      buffer += delta;
      return drain(false);
    },
    flush(): ThinkingPiece[] {
      return drain(true);
    },
  };
}
