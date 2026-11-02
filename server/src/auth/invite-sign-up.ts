/**
 * Invite-only servers (`PAPERCLIP_AUTH_DISABLE_SIGN_UP`) still let the people
 * they invite make an account: a sign-up that carries a live invite link's
 * token goes through, every other sign-up is refused. Better Auth's own
 * switch can't tell the two apart, so it stays open and this check decides.
 */
import { createHash } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { invites, type Db } from "@paperclipai/db";

/** The header the board's sign-up form sends the invite token in. */
export const INVITE_TOKEN_HEADER = "x-automa-invite-token";

export const SIGN_UP_OFF_MESSAGE = "Sign-up is turned off on this Automa server. Ask its owner for an invite link.";

export type InviteTokenCheck = (token: string) => Promise<boolean>;

/** True for an invite a person can still use: not revoked, used or expired, and open to people. */
export function createInviteTokenCheck(db: Db, now: () => Date = () => new Date()): InviteTokenCheck {
  return async (token) => {
    const trimmed = token.trim();
    if (!trimmed || trimmed.length > 512) return false;
    const tokenHash = createHash("sha256").update(trimmed).digest("hex");
    const row = await db
      .select({ allowedJoinTypes: invites.allowedJoinTypes, inviteType: invites.inviteType })
      .from(invites)
      .where(
        and(
          eq(invites.tokenHash, tokenHash),
          isNull(invites.revokedAt),
          isNull(invites.acceptedAt),
          gt(invites.expiresAt, now()),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!row) return false;
    return row.inviteType === "bootstrap_ceo" || row.allowedJoinTypes !== "agent";
  };
}

function headerValue(headers: unknown, name: string): string | null {
  if (headers && typeof (headers as Headers).get === "function") return (headers as Headers).get(name);
  return null;
}

/** The before-hook that keeps email sign-up closed except for invited people. */
export function inviteOnlySignUpPlugin(deps: { isUsableInviteToken: InviteTokenCheck }) {
  return {
    id: "automa-invite-only-sign-up",
    hooks: {
      before: [
        {
          matcher: (context: { path?: string }) => context.path === "/sign-up/email",
          handler: createAuthMiddleware(async (ctx) => {
            const token = headerValue(ctx.headers, INVITE_TOKEN_HEADER) ?? headerValue(ctx.request?.headers, INVITE_TOKEN_HEADER);
            if (token && (await deps.isUsableInviteToken(token))) return;
            throw new APIError("FORBIDDEN", { message: SIGN_UP_OFF_MESSAGE, code: "SIGN_UP_DISABLED" });
          }),
        },
      ],
    },
  };
}
