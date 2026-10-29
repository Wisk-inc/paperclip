import { describe, expect, it } from "vitest";
import { queryNetworkMode } from "./network-mode";

describe("queryNetworkMode", () => {
  it("never pauses requests to a server on this device", () => {
    for (const host of ["127.0.0.1", "127.0.0.2", "localhost", "LOCALHOST", "[::1]", "::1"]) expect(queryNetworkMode(host)).toBe("always");
  });

  it("waits for the connection with a remote server", () => {
    for (const host of ["automa.example.com", "192.168.1.20", "127.0.0.1.example.com", "10.0.2.2"]) expect(queryNetworkMode(host)).toBe("online");
  });
});
