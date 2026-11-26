import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  decideMigrationGate,
  pendingMigrationsRefusalMessage,
  runsAsAutomaOnPhone,
} from "../startup-migration-gate.ts";

const TERMUX_PREFIX = "/data/data/com.termux/files/usr";

describe("runsAsAutomaOnPhone", () => {
  it("recognises the automa launcher, Termux's PREFIX and Android", () => {
    expect(runsAsAutomaOnPhone({ AUTOMA_LAUNCHER: "1" }, "linux")).toBe(true);
    expect(runsAsAutomaOnPhone({ PREFIX: TERMUX_PREFIX }, "linux")).toBe(true);
    expect(runsAsAutomaOnPhone({}, "android")).toBe(true);
  });

  it("is false on an ordinary machine, including one with its own PREFIX", () => {
    expect(runsAsAutomaOnPhone({}, "linux")).toBe(false);
    expect(runsAsAutomaOnPhone({}, "darwin")).toBe(false);
    expect(runsAsAutomaOnPhone({ PREFIX: "/usr/local" }, "linux")).toBe(false);
    expect(runsAsAutomaOnPhone({ AUTOMA_LAUNCHER: "0" }, "linux")).toBe(false);
  });
});

describe("decideMigrationGate", () => {
  const desktop = (env: NodeJS.ProcessEnv, interactive: boolean) =>
    decideMigrationGate({ env, platform: "linux", interactive });

  it("keeps the upstream rules everywhere but the phone", () => {
    expect(desktop({}, true)).toBe("ask");
    expect(desktop({}, false)).toBe("apply");
    expect(desktop({ PAPERCLIP_MIGRATION_AUTO_APPLY: "true" }, true)).toBe("apply");
    expect(desktop({ PAPERCLIP_MIGRATION_AUTO_APPLY: "true", PAPERCLIP_MIGRATION_PROMPT: "never" }, true)).toBe("apply");
    expect(desktop({ PAPERCLIP_MIGRATION_PROMPT: "never" }, true)).toBe("refuse");
    expect(desktop({ PAPERCLIP_MIGRATION_PROMPT: "never" }, false)).toBe("refuse");
    // Upstream only ever looked for "true": "false" is not a refusal.
    expect(desktop({ PAPERCLIP_MIGRATION_AUTO_APPLY: "false" }, true)).toBe("ask");
    expect(desktop({ PAPERCLIP_MIGRATION_AUTO_APPLY: "false" }, false)).toBe("apply");
  });

  it("never asks on the phone, even on a terminal (automa onboard, the installer's last step)", () => {
    // The installer's `automa onboard --yes` runs the server in the
    // foreground on Termux's terminal, without AUTOMA_LAUNCHER today.
    expect(decideMigrationGate({ env: { PREFIX: TERMUX_PREFIX }, platform: "android", interactive: true })).toBe("apply");
    expect(decideMigrationGate({ env: { PREFIX: TERMUX_PREFIX }, platform: "linux", interactive: true })).toBe("apply");
    expect(decideMigrationGate({ env: { AUTOMA_LAUNCHER: "1" }, platform: "linux", interactive: true })).toBe("apply");
    expect(
      decideMigrationGate({ env: { AUTOMA_LAUNCHER: "1", PREFIX: TERMUX_PREFIX }, platform: "android", interactive: false }),
    ).toBe("apply");
    expect(
      decideMigrationGate({
        env: { PREFIX: TERMUX_PREFIX, PAPERCLIP_MIGRATION_AUTO_APPLY: "false" },
        platform: "android",
        interactive: true,
      }),
    ).toBe("apply");
  });

  it("still refuses on the phone when PAPERCLIP_MIGRATION_PROMPT=never is set, unless auto apply is on", () => {
    const phone = { AUTOMA_LAUNCHER: "1", PREFIX: TERMUX_PREFIX };
    expect(
      decideMigrationGate({ env: { ...phone, PAPERCLIP_MIGRATION_PROMPT: "never" }, platform: "android", interactive: true }),
    ).toBe("refuse");
    expect(
      decideMigrationGate({
        env: { ...phone, PAPERCLIP_MIGRATION_PROMPT: "never", PAPERCLIP_MIGRATION_AUTO_APPLY: "true" },
        platform: "android",
        interactive: true,
      }),
    ).toBe("apply");
  });
});

describe("decideMigrationGate without a migration journal", () => {
  const phone = { AUTOMA_LAUNCHER: "1", PREFIX: TERMUX_PREFIX };

  it("applies on a first install's empty database on the phone, and asks on a desktop terminal as before", () => {
    // The installer creates an empty automa database, then runs automa onboard on Termux's terminal.
    const reason = "no-migration-journal-empty-db" as const;
    expect(decideMigrationGate({ env: { PREFIX: TERMUX_PREFIX }, platform: "android", interactive: true, reason })).toBe("apply");
    expect(decideMigrationGate({ env: {}, platform: "linux", interactive: true, reason })).toBe("ask");
    expect(decideMigrationGate({ env: {}, platform: "linux", interactive: false, reason })).toBe("apply");
  });

  it("does not apply on the phone when tables exist without a journal: applying always fails there", () => {
    const reason = "no-migration-journal-non-empty-db" as const;
    expect(decideMigrationGate({ env: phone, platform: "android", interactive: true, reason })).toBe("refuse");
    expect(decideMigrationGate({ env: phone, platform: "android", interactive: false, reason })).toBe("refuse");
    expect(
      decideMigrationGate({ env: { ...phone, PAPERCLIP_MIGRATION_AUTO_APPLY: "true" }, platform: "android", interactive: false, reason }),
    ).toBe("refuse");
    // Off the phone the upstream flow is unchanged (the database layer then says why it cannot apply).
    expect(decideMigrationGate({ env: {}, platform: "linux", interactive: true, reason })).toBe("ask");
    expect(decideMigrationGate({ env: {}, platform: "linux", interactive: false, reason })).toBe("apply");
  });
});

describe("pendingMigrationsRefusalMessage", () => {
  const input = { label: "PostgreSQL", pendingSummary: "0291_reflective_loners.sql" };

  it("keeps the upstream wording off the phone", () => {
    expect(pendingMigrationsRefusalMessage({ ...input, env: { PAPERCLIP_MIGRATION_PROMPT: "never" }, platform: "linux" })).toBe(
      "PostgreSQL has pending migrations (0291_reflective_loners.sql). Refusing to start against a stale schema. " +
        "Run pnpm db:migrate or set PAPERCLIP_MIGRATION_AUTO_APPLY=true.",
    );
  });

  it("gives the phone a command that works there, last and without a full stop", () => {
    const message = pendingMigrationsRefusalMessage({
      ...input,
      env: { AUTOMA_LAUNCHER: "1", PREFIX: TERMUX_PREFIX, PAPERCLIP_MIGRATION_PROMPT: "never" },
      platform: "android",
    });
    expect(message).toBe(
      "PostgreSQL has pending migrations (0291_reflective_loners.sql). Refusing to start against a stale schema: " +
        "PAPERCLIP_MIGRATION_PROMPT=never is set. To apply them and start Automa, run: " +
        "PAPERCLIP_MIGRATION_AUTO_APPLY=true automa run",
    );
    expect(message).not.toContain("pnpm");
  });

  it("names no setting on the phone when none is set, and still ends with the command", () => {
    const message = pendingMigrationsRefusalMessage({ ...input, env: { PREFIX: TERMUX_PREFIX }, platform: "android" });
    expect(message).toMatch(/Refusing to start against a stale schema\. To apply them and start Automa, run: PAPERCLIP_MIGRATION_AUTO_APPLY=true automa run$/);
  });

  it("points the phone at automa restore when tables exist without a migration journal", () => {
    const message = pendingMigrationsRefusalMessage({
      label: "PostgreSQL",
      pendingSummary: "0000_mature_mandarin.sql, 0001_fast_northstar.sql (+290 more)",
      reason: "no-migration-journal-non-empty-db",
      env: { PREFIX: TERMUX_PREFIX },
      platform: "android",
    });
    expect(message).toBe(
      "PostgreSQL has tables but no migration history, so its pending migrations " +
        "(0000_mature_mandarin.sql, 0001_fast_northstar.sql (+290 more)) cannot be applied safely. " +
        "Refusing to start against a stale schema. Automa's backups keep the migration history; " +
        "to put the newest one back, run: automa restore",
    );
  });

  it("suggests neither auto apply nor db:migrate anywhere when tables exist without a migration journal", () => {
    // Both end in applyPendingMigrations, which refuses such a database every time.
    for (const platform of ["linux", "android"]) {
      const message = pendingMigrationsRefusalMessage({ ...input, reason: "no-migration-journal-non-empty-db", env: {}, platform });
      expect(message).not.toContain("PAPERCLIP_MIGRATION_AUTO_APPLY");
      expect(message).not.toContain("db:migrate");
    }
    expect(
      pendingMigrationsRefusalMessage({ ...input, reason: "no-migration-journal-non-empty-db", env: {}, platform: "linux" }),
    ).toBe(
      "PostgreSQL has tables but no migration history, so its pending migrations (0291_reflective_loners.sql) " +
        "cannot be applied safely. Refusing to start against a stale schema. " +
        "Restore a backup that includes the migration journal, or initialize the migration history manually.",
    );
  });

  it("keeps the ordinary wording for a first install's empty database", () => {
    expect(
      pendingMigrationsRefusalMessage({ ...input, reason: "no-migration-journal-empty-db", env: {}, platform: "linux" }),
    ).toContain("Run pnpm db:migrate or set PAPERCLIP_MIGRATION_AUTO_APPLY=true.");
  });

  it("keeps the words automa troubleshoot looks for", () => {
    // mobile/termux/automa-troubleshoot.sh matches this phrase in server.log.
    for (const platform of ["linux", "android"]) {
      for (const reason of ["pending-migrations", "no-migration-journal-empty-db", "no-migration-journal-non-empty-db"] as const) {
        expect(pendingMigrationsRefusalMessage({ ...input, reason, env: {}, platform })).toContain(
          "Refusing to start against a stale schema",
        );
      }
    }
  });
});

describe("the server's start", () => {
  it("decides and words pending migrations through the gate, not its own copy", () => {
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    expect(source).toContain("decideMigrationGate(");
    expect(source).toContain("pendingMigrationsRefusalMessage(");
    expect(source).not.toContain("Run pnpm db:migrate");
    expect(source).not.toMatch(/PAPERCLIP_MIGRATION_PROMPT/);
  });
});
