import { describe, expect, it } from "vitest";
import {
  bytesToPortableFileEntry,
  createStoredZipArchive as createPackageZip,
  isBlobStorePath,
  readZipArchive,
} from "../commands/client/zip.js";
import { createStoredZipArchive } from "./helpers/zip.js";

describe("isBlobStorePath", () => {
  it("matches blobs/ entries at the archive root and under a package root", () => {
    expect(isBlobStorePath("blobs/4f2d1c9a")).toBe(true);
    expect(isBlobStorePath("paperclip-demo/blobs/4f2d1c9a")).toBe(true);
    expect(isBlobStorePath("tasks/pap-1/TASK.md")).toBe(false);
    expect(isBlobStorePath("blobs/nested/file")).toBe(false);
  });
});

describe("bytesToPortableFileEntry", () => {
  it("keeps blobs/ entries as base64 octet streams regardless of extension", () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x80, 0xfe, 0xff]);
    expect(bytesToPortableFileEntry("blobs/4f2d1c9a", bytes)).toEqual({
      encoding: "base64",
      data: Buffer.from(bytes).toString("base64"),
      contentType: "application/octet-stream",
    });
  });

  it("falls back to base64 when bytes are not valid UTF-8", () => {
    const invalidUtf8 = new Uint8Array([0x68, 0x69, 0xff, 0xfe, 0xc0]);
    expect(bytesToPortableFileEntry("tasks/pap-1/raw-notes", invalidUtf8)).toEqual({
      encoding: "base64",
      data: Buffer.from(invalidUtf8).toString("base64"),
      contentType: "application/octet-stream",
    });
  });

  it("decodes valid UTF-8 entries to text", () => {
    const bytes = new TextEncoder().encode("# Notes\n\ncafé ✅\n");
    expect(bytesToPortableFileEntry("tasks/pap-1/TASK.md", bytes)).toBe("# Notes\n\ncafé ✅\n");
  });
});

describe("readZipArchive", () => {
  it("round-trips blob and invalid UTF-8 entries byte-exactly", async () => {
    const blobBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const invalidUtf8 = new Uint8Array([0x68, 0x69, 0xff, 0xfe, 0xc0]);
    const archive = createStoredZipArchive(
      {
        "COMPANY.md": "# Company\n",
        "blobs/4f2d1c9a": blobBytes,
        "notes/raw": invalidUtf8,
      },
      "paperclip-demo",
    );

    await expect(readZipArchive(archive)).resolves.toEqual({
      rootPath: "paperclip-demo",
      files: {
        "COMPANY.md": "# Company\n",
        "blobs/4f2d1c9a": {
          encoding: "base64",
          data: Buffer.from(blobBytes).toString("base64"),
          contentType: "application/octet-stream",
        },
        "notes/raw": {
          encoding: "base64",
          data: Buffer.from(invalidUtf8).toString("base64"),
          contentType: "application/octet-stream",
        },
      },
    });
  });
});

describe("createStoredZipArchive (the CLI's package zip)", () => {
  // The zip reader here does not check CRCs, so a wrong checksum would only
  // show up when someone opened the zip with another tool.
  it("writes each entry's standard CRC-32 in both its local and central headers", () => {
    const zip = Buffer.from(
      createPackageZip({ "check.txt": new TextEncoder().encode("123456789"), "empty.txt": new Uint8Array(0) }, "pkg"),
    );
    // "123456789" is the standard CRC-32 check input; its checksum is 0xCBF43926. An empty entry's is 0.
    const expected: Record<string, number> = { "pkg/check.txt": 0xcbf43926, "pkg/empty.txt": 0 };

    const local = new Map<string, number>();
    const central = new Map<string, number>();
    for (let offset = 0; offset + 4 <= zip.length; offset += 1) {
      const signature = zip.readUInt32LE(offset);
      if (signature === 0x04034b50) {
        const nameLength = zip.readUInt16LE(offset + 26);
        local.set(zip.toString("utf8", offset + 30, offset + 30 + nameLength), zip.readUInt32LE(offset + 14));
      } else if (signature === 0x02014b50) {
        const nameLength = zip.readUInt16LE(offset + 28);
        central.set(zip.toString("utf8", offset + 46, offset + 46 + nameLength), zip.readUInt32LE(offset + 16));
      }
    }

    expect(Object.fromEntries(local)).toEqual(expected);
    expect(Object.fromEntries(central)).toEqual(expected);
  });
});
