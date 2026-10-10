import { useCallback, useEffect, useRef, useState } from "react";
import type { StudioClientEvent, StudioServerEvent } from "@paperclipai/shared";

export type StudioSocketStatus = "connecting" | "open" | "closed" | "kicked";

/**
 * The live Studio socket for one project: typing, presence, file saves, the
 * console, the chat, and the assistant. Reconnects with backoff until the
 * page leaves or the owner removes this collaborator.
 */
export function useStudioSocket(url: string | null, onEvent: (event: StudioServerEvent) => void) {
  const [status, setStatus] = useState<StudioSocketStatus>("connecting");
  const socketRef = useRef<WebSocket | null>(null);
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    if (!url) return;
    let stopped = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;

    const connect = () => {
      if (stopped) return;
      setStatus("connecting");
      const socket = new WebSocket(url);
      socketRef.current = socket;
      socket.onopen = () => {
        attempt = 0;
        setStatus("open");
        pingTimer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" } satisfies StudioClientEvent));
        }, 25_000);
      };
      socket.onmessage = (message) => {
        try {
          const event = JSON.parse(String(message.data)) as StudioServerEvent;
          if (event.type === "kicked") {
            stopped = true;
            setStatus("kicked");
          }
          handlerRef.current(event);
        } catch {
          // ignore malformed frames
        }
      };
      socket.onclose = (event) => {
        if (pingTimer) clearInterval(pingTimer);
        pingTimer = null;
        if (socketRef.current === socket) socketRef.current = null;
        if (stopped || event.code === 4001) {
          if (event.code === 4001) setStatus("kicked");
          return;
        }
        setStatus("closed");
        attempt += 1;
        retryTimer = setTimeout(connect, Math.min(15_000, 500 * 2 ** Math.min(attempt, 5)));
      };
    };
    connect();
    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (pingTimer) clearInterval(pingTimer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [url]);

  const send = useCallback((event: StudioClientEvent) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
  }, []);

  return { status, send };
}
