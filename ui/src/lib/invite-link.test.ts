import { describe, expect, it } from "vitest";
import { inviteTargetFromInput } from "./invite-link";

describe("inviteTargetFromInput", () => {
  const origin = "https://automa.example";
  it("opens a pasted link or bare token on this server", () => {
    expect(inviteTargetFromInput("https://automa.example/invite/pcp_invite_abc-DEF_123", origin)).toEqual({ ok: true, path: "/invite/pcp_invite_abc-DEF_123" });
    expect(inviteTargetFromInput("  pcp_invite_xyz  ", origin)).toEqual({ ok: true, path: "/invite/pcp_invite_xyz" });
    expect(inviteTargetFromInput("Join us: /invite/pcp_invite_q1", origin)).toEqual({ ok: true, path: "/invite/pcp_invite_q1" });
  });

  it("says where another server's invite belongs, and what isn't an invite", () => {
    expect(inviteTargetFromInput("https://other.example:3100/invite/pcp_invite_abc", origin)).toEqual({
      ok: false,
      message: "This invite is for other.example:3100. Open it there, or connect the app to that server first.",
    });
    expect(inviteTargetFromInput("https://automa.example/issues/1", origin)).toMatchObject({ ok: false });
    expect(inviteTargetFromInput("", origin)).toMatchObject({ ok: false, message: "Paste the invite link you were sent." });
  });
});
