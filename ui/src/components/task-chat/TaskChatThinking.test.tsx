// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { MemoryRouter } from "@/lib/router";
import { TaskChatThinking } from "./TaskChatThinking";
import type { TaskChatThinkingItem } from "./task-chat-model";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("TaskChatThinking", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const item = (streaming: boolean): TaskChatThinkingItem => ({
    id: "thinking-1",
    kind: "thinking",
    lines: ["Reading the task first.", "Then I will check the tests."],
    streaming,
  });

  const render = (streaming: boolean) =>
    act(() => {
      root.render(<ThemeProvider><MemoryRouter><TaskChatThinking item={item(streaming)} /></MemoryRouter></ThemeProvider>);
    });

  it("shows the thought live, then folds it to one line when the reply starts", () => {
    render(true);
    expect(container.querySelector('[data-testid="task-chat-thinking-live"]')).not.toBeNull();
    render(false);
    const thinking = container.querySelector('[data-testid="task-chat-thinking"]');
    expect(thinking?.getAttribute("data-state")).toBe("settled");
    expect(container.querySelector('[data-testid="task-chat-thinking-live"]')).toBeNull();
    expect(container.querySelector('[data-testid="task-chat-thinking-preview"]')?.textContent).toContain("Reading the task");
    const toggle = container.querySelector("button");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    act(() => toggle?.click());
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Then I will check the tests.");
  });
});
