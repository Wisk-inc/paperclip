/**
 * Better Auth plugin: "Continue with Google" from the Automa Android app.
 *
 * The app signs the person in to Firebase Auth with Google and posts the
 * Firebase ID token here. After verifying it, this endpoint signs the person
 * in to the board: an existing user with the same (Google-verified) email is
 * signed in and the Firebase identity is linked; otherwise a user is created,
 * unless sign-up is turned off on this server. Sessions and cookies go
 * through Better Auth (`internalAdapter.createSession` + `setSessionCookie`).
 *
 * Registered only when AUTOMA_FIREBASE_PROJECT_ID is set.
 */
import { z } from "zod";
import { setSessionCookie } from "better-auth/cookies";
import { createAuthEndpoint } from "better-auth/api";
import type { Session, User } from "better-auth/types";
import { logger } from "../middleware/logger.js";
import {
  createFirebaseCertSource,
  FirebaseIdTokenError,
  verifyFirebaseIdToken,
  type FirebaseCertSource,
  type FirebaseIdTokenClaims,
} from "./firebase-id-token.js";

export const FIREBASE_SIGN_IN_PATH = "/firebase/sign-in";
export const FIREBASE_ACCOUNT_PROVIDER_ID = "firebase";

type Account = { providerId: string; accountId: string };

/** The subset of Better Auth's internal adapter this sign-in uses. */
export type FirebaseSignInAdapter = {
  findUserByEmail: (
    email: string,
    options?: { includeAccounts: boolean },
  ) => Promise<{ user: User; accounts: Account[] } | null>;
  createUser: (
    user: { email: string; name: string; image?: string | null; emailVerified?: boolean },
    source: { method: string; oauth?: { providerId: string; profile?: Record<string, unknown> } },
  ) => Promise<User>;
  linkAccount: (account: { userId: string; providerId: string; accountId: string }) => Promise<unknown>;
};

type FirebaseSignInEndpointContext = {
  body: { idToken: string };
  setHeader: (name: string, value: string) => void;
  error: (status: string, body?: { message?: string }) => Error;
  json: (value: unknown) => unknown;
  context: {
    internalAdapter: FirebaseSignInAdapter & { createSession: (userId: string) => Promise<Session> };
  };
};

/**
 * Finds or creates the board user for a verified Firebase identity and links
 * the Firebase account. Existing users are matched by their Google-verified
 * email; new users are created only when sign-up is allowed.
 */
export async function resolveFirebaseUser(input: {
  claims: FirebaseIdTokenClaims;
  adapter: FirebaseSignInAdapter;
  disableSignUp: boolean;
}): Promise<{ ok: true; user: User; created: boolean } | { ok: false; message: string }> {
  const { claims, adapter } = input;
  if (!claims.email || !claims.emailVerified) {
    return { ok: false, message: "Your Google account needs a verified email address." };
  }
  const email = claims.email.toLowerCase();
  const existing = await adapter.findUserByEmail(email, { includeAccounts: true });
  let user = existing?.user ?? null;
  let created = false;
  if (!user) {
    if (input.disableSignUp) {
      return { ok: false, message: "Sign-up is turned off on this Automa server. Ask its owner for an invite." };
    }
    user = await adapter.createUser(
      {
        email,
        name: claims.name ?? email.split("@")[0] ?? email,
        image: claims.picture,
        emailVerified: true,
      },
      {
        method: "oauth",
        oauth: {
          providerId: FIREBASE_ACCOUNT_PROVIDER_ID,
          profile: { sub: claims.uid, email, name: claims.name, picture: claims.picture },
        },
      },
    );
    created = true;
  }
  const alreadyLinked = (existing?.accounts ?? []).some(
    (account) => account.providerId === FIREBASE_ACCOUNT_PROVIDER_ID && account.accountId === claims.uid,
  );
  if (!alreadyLinked) {
    await adapter.linkAccount({ userId: user.id, providerId: FIREBASE_ACCOUNT_PROVIDER_ID, accountId: claims.uid });
  }
  return { ok: true, user, created };
}

export function firebaseSignInPlugin(deps: {
  projectId: string;
  disableSignUp: boolean;
  certs?: FirebaseCertSource;
}) {
  const certs = deps.certs ?? createFirebaseCertSource();
  return {
    id: "automa-firebase-sign-in",
    endpoints: {
      signInWithFirebase: createAuthEndpoint(
        FIREBASE_SIGN_IN_PATH,
        {
          method: "POST",
          requireHeaders: true,
          body: z.object({ idToken: z.string().min(1).max(8192) }),
        },
        async (endpointContext) => {
          const ctx = endpointContext as unknown as FirebaseSignInEndpointContext;
          ctx.setHeader("Cache-Control", "no-store");

          let claims;
          try {
            claims = await verifyFirebaseIdToken(ctx.body.idToken, { projectId: deps.projectId, certs });
          } catch (error) {
            logger.warn(
              { reason: error instanceof FirebaseIdTokenError ? error.reason : "verify_failed" },
              "Firebase sign-in rejected",
            );
            throw ctx.error("UNAUTHORIZED", { message: "Google sign-in could not be verified. Try again." });
          }
          const adapter = ctx.context.internalAdapter;
          const outcome = await resolveFirebaseUser({ claims, adapter, disableSignUp: deps.disableSignUp });
          if (!outcome.ok) throw ctx.error("FORBIDDEN", { message: outcome.message });
          const user = outcome.user;

          const session = await adapter.createSession(user.id);
          await setSessionCookie(ctx as never, { session, user });
          return ctx.json({ user: { id: user.id, email: user.email, name: user.name } });
        },
      ),
    },
  };
}

/** The Firebase project whose ID tokens this server accepts, if configured. */
export function resolveFirebaseProjectId(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.AUTOMA_FIREBASE_PROJECT_ID?.trim();
  return value && /^[a-z0-9-]{4,64}$/.test(value) ? value : null;
}
