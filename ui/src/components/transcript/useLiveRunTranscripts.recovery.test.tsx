// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLiveRunTranscripts } from "./useLiveRunTranscripts";

const { logMock } = vi.hoisted(() => ({ logMock: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { censorUsernameInLogs: false } }) }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { getGeneral: vi.fn() } }));
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: { log: logMock } }));
vi.mock("@/adapters", () => ({
  buildTranscript: (chunks: unknown[]) => chunks,
  getUIAdapter: () => null,
  onAdapterChange: () => () => {},
}));

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  close() {
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  drop() {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close"));
  }
  deliver(event: unknown) {
    this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
  }
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The server's log file for run-1 (ASCII, so bytes equal characters).
let records: string[] = [];
const file = () => records.map((record) => `${record}\n`).join("");
function serverWrites(seq: number) {
  const ts = `2026-10-22T00:00:0${seq}.000Z`;
  records.push(JSON.stringify({ ts, stream: "stdout", chunk: `tok${seq}`, seq }));
  return { ts, seq, chunk: `tok${seq}` };
}
const liveLog = (record: { ts: string; seq: number; chunk: string }) => ({
  companyId: "company-1",
  type: "heartbeat.run.log",
  createdAt: record.ts,
  payload: { runId: "run-1", ts: record.ts, seq: record.seq, stream: "stdout", chunk: record.chunk },
});

describe("useLiveRunTranscripts recovery", () => {
  const OriginalWebSocket = globalThis.WebSocket;
  beforeEach(() => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    FakeWebSocket.instances = [];
    records = [];
    logMock.mockReset();
    logMock.mockImplementation(async (_runId: string, offset: number, limit: number) => {
      const all = file();
      const content = all.slice(offset, offset + limit);
      const end = offset + content.length;
      return { runId: "run-1", store: "local_file", logRef: "x", content, nextOffset: end < all.length ? end : undefined };
    });
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  });
  afterEach(() => {
    globalThis.WebSocket = OriginalWebSocket;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("reads output written while the socket was down as soon as it reconnects", async () => {
    vi.useFakeTimers();
    let latest: string[] = [];
    function Harness({ bytes }: { bytes: number }) {
      const { transcriptByRun } = useLiveRunTranscripts({
        companyId: "company-1",
        runs: [{ id: "run-1", status: "running", adapterType: "claude_local", lastOutputBytes: bytes }],
      });
      latest = ((transcriptByRun.get("run-1") ?? []) as unknown as Array<{ chunk: string }>).map((chunk) => chunk.chunk);
      return null;
    }
    serverWrites(1);
    const root = createRoot(document.createElement("div"));
    try {
      await act(async () => root.render(<Harness bytes={file().length} />));
      const first = FakeWebSocket.instances.at(-1)!;
      await act(async () => first.open());
      await act(async () => first.deliver(liveLog(serverWrites(2))));
      await act(async () => first.drop());
      serverWrites(3); // written while nothing listens
      await act(async () => vi.advanceTimersByTimeAsync(1_600));
      const second = FakeWebSocket.instances.at(-1)!;
      expect(second).not.toBe(first);
      await act(async () => second.open());
      await act(async () => vi.advanceTimersByTimeAsync(50));
      expect(latest).toEqual(["tok1", "tok2", "tok3"]);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("keeps a run's error and status lines that arrive while streamed text is pending", async () => {
    let latest: string[] = [];
    const runs = [{ id: "run-1", status: "running", adapterType: "claude_local" }];
    function Harness() {
      const { transcriptByRun } = useLiveRunTranscripts({ companyId: "company-1", runs });
      latest = ((transcriptByRun.get("run-1") ?? []) as unknown as Array<{ chunk: string }>).map((chunk) => chunk.chunk);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    try {
      await act(async () => root.render(<Harness />));
      const socket = FakeWebSocket.instances.at(-1)!;
      await act(async () => socket.open());
      await act(async () => {
        socket.deliver(liveLog({ ts: "2026-10-22T00:00:01.000Z", seq: 1, chunk: "tok1" }));
        socket.deliver({
          companyId: "company-1",
          type: "heartbeat.run.event",
          createdAt: "2026-10-22T00:00:05.000Z",
          payload: { runId: "run-1", seq: 77, eventType: "error", message: "adapter failed: API key rejected" },
        });
        socket.deliver(liveLog({ ts: "2026-10-22T00:00:02.000Z", seq: 2, chunk: "tok2" }));
      });
      await act(async () => {
        socket.deliver(liveLog({ ts: "2026-10-22T00:00:03.000Z", seq: 3, chunk: "tok3" }));
        socket.deliver({
          companyId: "company-1",
          type: "heartbeat.run.status",
          createdAt: "2026-10-22T00:00:09.000Z",
          payload: { runId: "run-1", status: "failed", finishedAt: "2026-10-22T00:00:09.000Z" },
        });
      });
      expect(latest).toEqual(expect.arrayContaining(["tok1", "tok2", "tok3", "adapter failed: API key rejected", "run failed"]));
    } finally {
      await act(async () => root.unmount());
    }
  });
});
