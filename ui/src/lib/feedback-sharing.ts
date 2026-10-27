import type { FeedbackDataSharingPreference } from "@paperclipai/shared";

/**
 * Whether thumbs-up/down votes can be shared outside this device at all.
 * Automa keeps votes on the device: its builds have no sharing endpoint of
 * their own, and the upstream one belongs to a different company. A build
 * that does run its own endpoint sets VITE_FEEDBACK_SHARING=1 (and the server
 * sets PAPERCLIP_FEEDBACK_EXPORT_BACKEND_URL).
 */
export const FEEDBACK_SHARING_AVAILABLE = import.meta.env.VITE_FEEDBACK_SHARING === "1";

/** The preference to act on: "keep it local" whenever sharing is unavailable, so nobody is asked to consent to nothing. */
export function effectiveFeedbackSharingPreference(
  preference: FeedbackDataSharingPreference | null | undefined,
  available: boolean = FEEDBACK_SHARING_AVAILABLE,
): FeedbackDataSharingPreference {
  if (!available) return "not_allowed";
  return preference ?? "prompt";
}
