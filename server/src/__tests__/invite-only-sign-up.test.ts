import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, it, vi } from "vitest";
import { INVITE_TOKEN_HEADER, inviteOnlySignUpPlugin } from "../auth/invite-sign-up.js";

function makeAuth(isUsableInviteToken: (token: string) => Promise<boolean>) {
  return betterAuth({
    secret: "invite-only-sign-up-test-secret-0123456789",
    baseURL: "http://localhost:3100",
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    emailAndPassword: { enabled: true, requireEmailVerification: false, disableSignUp: false },
    plugins: [inviteOnlySignUpPlugin({ isUsableInviteToken }) as never],
  });
}

const body = { name: "Ada", email: "ada@example.com", password: "correct horse battery" };

describe("invite-only sign-up", () => {
  it("refuses a sign-up with no invite, or with one that is no longer usable", async () => {
    const check = vi.fn(async (token: string) => token === "pcp_invite_live");
    const auth = makeAuth(check);
    await expect(auth.api.signUpEmail({ body, headers: new Headers() })).rejects.toMatchObject({
      message: expect.stringContaining("Ask its owner for an invite link"),
    });
    await expect(
      auth.api.signUpEmail({ body, headers: new Headers({ [INVITE_TOKEN_HEADER]: "pcp_invite_used" }) }),
    ).rejects.toMatchObject({ message: expect.stringContaining("Sign-up is turned off") });
    expect(check).toHaveBeenCalledWith("pcp_invite_used");
  });

  it("lets a person holding a live invite link make an account", async () => {
    const auth = makeAuth(async (token) => token === "pcp_invite_live");
    const result = await auth.api.signUpEmail({ body, headers: new Headers({ [INVITE_TOKEN_HEADER]: "pcp_invite_live" }) });
    expect(result.user.email).toBe("ada@example.com");
  });

  it("leaves sign-in alone", async () => {
    const auth = makeAuth(async (token) => token === "pcp_invite_live");
    await auth.api.signUpEmail({ body, headers: new Headers({ [INVITE_TOKEN_HEADER]: "pcp_invite_live" }) });
    const signedIn = await auth.api.signInEmail({ body: { email: body.email, password: body.password }, headers: new Headers() });
    expect(signedIn.user.email).toBe("ada@example.com");
  });
});
