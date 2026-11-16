// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER_BACK_EVENT } from "../lib/connection-recovery";
import { invalidateConfigSchemaCache, useConfigSchema } from "./schema-config-fields";

const schemaAnswer = (label: string) => ({
  ok: true,
  status: 200,
  json: async () => ({ fields: [{ key: "model", label, type: "text" }] }),
});

function SchemaLabels({ adapterType }: { adapterType: string }) {
  const schema = useConfigSchema(adapterType);
  return <div>{schema ? schema.fields.map((field) => field.label).join(", ") : "no fields"}</div>;
}

let root: Root | undefined;
let container: HTMLDivElement;

async function show(adapterType: string) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<SchemaLabels adapterType={adapterType} />));
}

describe("adapter settings fields after a dropped connection", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = undefined;
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("asks again by itself when the request never reached the server, and shows the fields once Automa answers", async () => {
    const type = "reconnect-retry";
    invalidateConfigSchemaCache(type);
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(schemaAnswer("Model"));
    vi.stubGlobal("fetch", fetchMock);

    await show(type);
    expect(container.textContent).toBe("no fields");

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe("Model");

    // Loaded: nothing more is asked.
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("asks at once when the network comes back, not at the next try", async () => {
    const type = "reconnect-online";
    invalidateConfigSchemaCache(type);
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(schemaAnswer("Effort"));
    vi.stubGlobal("fetch", fetchMock);

    await show(type);
    await act(async () => { window.dispatchEvent(new Event("online")); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe("Effort");
  });

  it("asks again when the server is not ready yet (503), and at once when the Automa app says its server is back", async () => {
    const type = "reconnect-server-error";
    invalidateConfigSchemaCache(type);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: "database_unavailable" }) })
      .mockResolvedValueOnce(schemaAnswer("Sandbox"));
    vi.stubGlobal("fetch", fetchMock);

    await show(type);
    expect(container.textContent).toBe("no fields");
    await act(async () => { window.dispatchEvent(new Event(SERVER_BACK_EVENT)); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe("Sandbox");
  });

  it("does not keep asking when the server answered that building the settings failed", async () => {
    const type = "reconnect-server-failure";
    invalidateConfigSchemaCache(type);
    // A 500 is the adapter's own error, logged on the server each time: asking
    // again every few seconds would only fill the log.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "Failed to resolve config schema: codex is not installed" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await show(type);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("no fields");
  });

  it("does not ask again about an adapter the server says has no settings", async () => {
    const type = "reconnect-no-schema";
    invalidateConfigSchemaCache(type);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: `Adapter "${type}" does not provide a config schema.` }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await show(type);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event(SERVER_BACK_EVENT));
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("no fields");

    // Opening the form again does not ask either.
    await act(async () => root?.unmount());
    await show(type);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops asking once the form is closed", async () => {
    const type = "reconnect-unmount";
    invalidateConfigSchemaCache(type);
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);

    await show(type);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => root?.unmount());
    root = undefined;
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
