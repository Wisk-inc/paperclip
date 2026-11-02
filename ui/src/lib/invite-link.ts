/** An invite token as the server mints it: `pcp_invite_` plus base64url. */
const INVITE_TOKEN = /pcp_invite_[A-Za-z0-9_-]+/;

/**
 * Where a pasted invite link (or bare token) opens on this server. A link to
 * another server is refused with where it belongs: its token means nothing here.
 */
export function inviteTargetFromInput(
  input: string,
  origin: string,
): { ok: true; path: string } | { ok: false; message: string } {
  const text = input.trim();
  if (!text) return { ok: false, message: "Paste the invite link you were sent." };
  const token = INVITE_TOKEN.exec(text)?.[0];
  if (!token) return { ok: false, message: "That doesn't look like an Automa invite link." };
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      if (url.origin !== origin) {
        return { ok: false, message: `This invite is for ${url.host}. Open it there, or connect the app to that server first.` };
      }
    } catch {
      // Not a URL after all; the token alone still opens here.
    }
  }
  return { ok: true, path: `/invite/${token}` };
}
