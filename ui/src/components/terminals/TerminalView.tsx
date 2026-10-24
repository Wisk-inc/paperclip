import { useCallback, useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTermTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { buildSameOriginWebSocketUrl } from "@/lib/websocket-url";
import { terminalsApi } from "@/api/terminals";
import { haptic } from "@/lib/haptics";
import { cn } from "@/lib/utils";

/** The keys a phone keyboard can't send, but a terminal program needs. */
const KEY_BAR: Array<{ label: string; send: string }> = [
  { label: "Esc", send: "\x1b" },
  { label: "Tab", send: "\t" },
  { label: "Ctrl C", send: "\x03" },
  { label: "Ctrl D", send: "\x04" },
  { label: "Ctrl Z", send: "\x1a" },
  { label: "↑", send: "\x1b[A" },
  { label: "↓", send: "\x1b[B" },
  { label: "←", send: "\x1b[D" },
  { label: "→", send: "\x1b[C" },
];

function base64FromString(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesFromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * A live terminal: xterm wired to a session's WebSocket. Keystrokes go up,
 * output comes down, and the window size follows the box. A key bar sends the
 * keys a phone keyboard lacks.
 */
export function TerminalView({
  companyId,
  sessionId,
  onExit,
  className,
}: {
  companyId: string;
  sessionId: string;
  onExit?: (code: number | null) => void;
  className?: string;
}) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTermTerminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<"connecting" | "open" | "closed">("connecting");
  const [exitCode, setExitCode] = useState<number | null>(null);

  const sendInput = useCallback((data: string) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ t: "i", d: base64FromString(data) }));
    }
  }, []);

  const sendResize = useCallback(() => {
    const socket = socketRef.current;
    const term = termRef.current;
    if (socket && socket.readyState === WebSocket.OPEN && term) {
      socket.send(JSON.stringify({ t: "r", c: term.cols, r: term.rows }));
    }
  }, []);

  // Build the terminal once.
  useEffect(() => {
    const element = elementRef.current;
    if (!element || termRef.current) return undefined;
    const term = new XTermTerminal({
      cols: 80,
      rows: 24,
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.3,
      scrollback: 5000,
      theme: {
        // token-extraction: allowlisted — xterm.js theme config; a functional
        // third-party option object, not a rendered CSS value. Terminals are
        // conventionally dark, matching the app's default surface.
        background: "#0a0a0a",
        foreground: "#f5f5f5",
        cursor: "#f5f5f5",
        selectionBackground: "#ffffff40",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    termRef.current = term;
    fitRef.current = fit;
    const input = term.onData(sendInput);
    const safeFit = () => {
      try {
        fit.fit();
        sendResize();
      } catch {
        // hidden/transition layouts throw; the observer retries
      }
    };
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => safeFit()) : null;
    observer?.observe(element);
    const timers = [50, 250].map((delay) => window.setTimeout(safeFit, delay));
    term.focus();
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
      observer?.disconnect();
      input.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sendInput, sendResize]);

  // Connect (and reconnect when the session changes).
  useEffect(() => {
    if (typeof WebSocket === "undefined") return undefined;
    setStatus("connecting");
    setExitCode(null);
    const socket = new WebSocket(buildSameOriginWebSocketUrl(terminalsApi.wsPath(companyId, sessionId)));
    socketRef.current = socket;
    socket.onopen = () => {
      setStatus("open");
      sendResize();
      termRef.current?.focus();
    };
    socket.onmessage = (event) => {
      let message: { t?: string; d?: string; code?: number | null };
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.t === "o" && typeof message.d === "string") {
        termRef.current?.write(bytesFromBase64(message.d));
      } else if (message.t === "x") {
        setExitCode(message.code ?? null);
        onExit?.(message.code ?? null);
      }
    };
    socket.onclose = () => {
      setStatus("closed");
      if (socketRef.current === socket) socketRef.current = null;
    };
    socket.onerror = () => setStatus("closed");
    return () => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000, "left");
      }
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [companyId, sessionId, sendResize, onExit]);

  return (
    <div className={cn("flex min-h-0 flex-col", className)} data-testid="terminal-view">
      <div ref={elementRef} className="min-h-0 flex-1 overflow-hidden bg-(--terminal-surface) p-1.5" data-testid="terminal-screen" />
      {exitCode !== null ? (
        <p className="shrink-0 border-t border-border bg-card px-3 py-1.5 text-xs text-muted-foreground" aria-live="polite">
          The program exited{exitCode ? ` (code ${exitCode})` : ""}. Close this terminal or open it again.
        </p>
      ) : status === "closed" ? (
        <p className="shrink-0 border-t border-border bg-card px-3 py-1.5 text-xs text-muted-foreground">Disconnected.</p>
      ) : null}
      {/* The keys a phone keyboard can't send. */}
      <div className="flex shrink-0 gap-1 overflow-x-auto border-t border-border bg-card px-2 py-1.5" aria-label="Terminal keys">
        {KEY_BAR.map((key) => (
          <button
            key={key.label}
            type="button"
            className="min-h-9 shrink-0 rounded-md border border-border px-2.5 font-mono text-xs text-foreground transition-colors hover:bg-accent active:bg-accent"
            onClick={() => {
              haptic("tick");
              sendInput(key.send);
              termRef.current?.focus();
            }}
          >
            {key.label}
          </button>
        ))}
      </div>
    </div>
  );
}
