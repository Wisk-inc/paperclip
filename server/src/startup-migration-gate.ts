/**
 * Whether the server applies pending database migrations when it starts,
 * and what a refusal tells the person to do.
 *
 * Upstream Paperclip applies them when PAPERCLIP_MIGRATION_AUTO_APPLY=true or
 * when nobody is at a terminal, refuses when PAPERCLIP_MIGRATION_PROMPT=never,
 * and otherwise asks on the terminal, where Enter means No.
 *
 * Automa on a phone never asks. Its updater copies the database before every
 * update (automa-before-<version>-*.sql.gz, which `automa restore` lists) and
 * the server saves a copy every hour while it runs, so applying is what an
 * update means there. The question also reaches nobody: `automa onboard`, the
 * installer's last step, opens the Automa app before the server starts, so
 * the prompt waits in Termux behind the app, and pressing Enter there (No)
 * leaves the updated Automa stopped. A phone has no pnpm either, so the
 * upstream remedy does not work there.
 */
import { startedByAutomaLauncher } from "./safe-mode.js";

export type MigrationGateDecision = "apply" | "refuse" | "ask";

/** Why migrations are pending (inspectMigrations in @paperclipai/db). */
export type PendingMigrationsReason =
  | "no-migration-journal-empty-db"
  | "no-migration-journal-non-empty-db"
  | "pending-migrations";

/**
 * Automa's phone server: started by the `automa` launcher (AUTOMA_LAUNCHER=1),
 * or running in Termux, which is how the rest of the server recognises the
 * phone too. Termux covers `automa onboard`, which does not set the launcher
 * flag.
 */
export function runsAsAutomaOnPhone(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): boolean {
  return startedByAutomaLauncher(env) || platform === "android" || (env.PREFIX ?? "").includes("com.termux");
}

export function decideMigrationGate(input: {
  /** Both stdin and stdout are a terminal, so someone could answer a question. */
  interactive: boolean;
  reason?: PendingMigrationsReason;
  env?: NodeJS.ProcessEnv;
  platform?: string;
}): MigrationGateDecision {
  const env = input.env ?? process.env;
  const phone = runsAsAutomaOnPhone(env, input.platform ?? process.platform);
  // Tables without a migration journal cannot be migrated: applyPendingMigrations
  // refuses them every time. Upstream still asks; the phone, which answers for
  // the person, stops here instead, with the remedy that works.
  if (phone && input.reason === "no-migration-journal-non-empty-db") return "refuse";
  if (env.PAPERCLIP_MIGRATION_AUTO_APPLY === "true") return "apply";
  // An explicit "never apply by itself" holds on a phone too.
  if (env.PAPERCLIP_MIGRATION_PROMPT === "never") return "refuse";
  if (phone) return "apply";
  if (!input.interactive) return "apply";
  return "ask";
}

export function pendingMigrationsRefusalMessage(input: {
  label: string;
  pendingSummary: string;
  reason?: PendingMigrationsReason;
  env?: NodeJS.ProcessEnv;
  platform?: string;
}): string {
  const env = input.env ?? process.env;
  const phone = runsAsAutomaOnPhone(env, input.platform ?? process.platform);
  // "Refusing to start against a stale schema" stays in every wording: automa troubleshoot looks for it.
  if (input.reason === "no-migration-journal-non-empty-db") {
    // Neither PAPERCLIP_MIGRATION_AUTO_APPLY nor pnpm db:migrate helps here: both
    // end in applyPendingMigrations, which refuses such a database.
    const refused =
      `${input.label} has tables but no migration history, so its pending migrations (${input.pendingSummary}) ` +
      "cannot be applied safely. Refusing to start against a stale schema.";
    return phone
      ? `${refused} Automa's backups keep the migration history; to put the newest one back, run: automa restore`
      : `${refused} Restore a backup that includes the migration journal, or initialize the migration history manually.`;
  }
  const refused = `${input.label} has pending migrations (${input.pendingSummary}). Refusing to start against a stale schema`;
  if (!phone) {
    return `${refused}. Run pnpm db:migrate or set PAPERCLIP_MIGRATION_AUTO_APPLY=true.`;
  }
  // On the phone Automa refuses only when told to, and the setting may live in
  // a file, so the command overrides it for this one start instead.
  const why = env.PAPERCLIP_MIGRATION_PROMPT === "never" ? ": PAPERCLIP_MIGRATION_PROMPT=never is set" : "";
  return `${refused}${why}. To apply them and start Automa, run: PAPERCLIP_MIGRATION_AUTO_APPLY=true automa run`;
}
