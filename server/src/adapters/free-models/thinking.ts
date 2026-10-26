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

const MAX_SHOWN_THINKING = 1500;

/** Thinking as a quoted block above the answer, trimmed so long chains stay readable on a phone. */
export function formatWithThinking(thinking: string, answer: string): string {
  if (!thinking) return answer;
  const shown = thinking.length > MAX_SHOWN_THINKING ? `${thinking.slice(0, MAX_SHOWN_THINKING).trimEnd()}…` : thinking;
  const quoted = shown.split("\n").map((line) => `> ${line}`).join("\n");
  return `> **Thinking**\n>\n${quoted}\n\n${answer}`;
}
