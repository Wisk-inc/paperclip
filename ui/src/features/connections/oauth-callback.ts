/**
 * What a provider sign-in that came back without connecting says, shared by
 * the setup flow and an app's page (a reconnect returns to the app's page).
 */

/** A GitHub recovery link from the callback, or null unless it is https on github.com. */
export function githubRecoveryUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "github.com"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function oauthCallbackErrorMessage(outcome: string | null, code: string | null): string {
  if (outcome === "denied") {
    return "Authorization was cancelled or declined. Your saved connection was not changed.";
  }
  if (code === "github_installation_required") {
    return "GitHub access is required. Install Automa and grant at least one repository, then try again.";
  }
  return "Authorization did not complete. Your saved connection is still here, so you can try again.";
}
