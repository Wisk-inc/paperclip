import { describe, expect, it } from "vitest";
import { applyChatOrder, moveInOrder, parseChatOrder } from "./chat-order";

describe("chat order", () => {
  it("sorts by the saved order and keeps new chats after it", () => {
    const items = ["a", "b", "c", "d"].map((id) => ({ id }));
    expect(applyChatOrder(items, ["c", "a"]).map((item) => item.id)).toEqual(["c", "a", "b", "d"]);
  });

  it("moves a chat one place up or down and stops at the ends", () => {
    expect(moveInOrder(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveInOrder(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
    expect(moveInOrder(["a", "b", "c"], "a", -1)).toEqual(["a", "b", "c"]);
    expect(moveInOrder(["a", "b", "c"], "c", 1)).toEqual(["a", "b", "c"]);
  });

  it("ignores damaged saved data", () => {
    expect(parseChatOrder("not json")).toEqual([]);
    expect(parseChatOrder('["a", 3, "a", "b"]')).toEqual(["a", "b"]);
  });
});
