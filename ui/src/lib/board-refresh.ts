import type { QueryClient } from "@tanstack/react-query";

/**
 * Sent when the person asks the board to load everything again (Refresh in
 * the header). The live updates connection listens for it and reconnects.
 */
export const BOARD_REFRESH_EVENT = "automa:refresh";

/**
 * Loads everything on screen again from the server, marks the rest to load
 * the next time it is shown, and has the live updates reconnect. Nothing on
 * the page is lost (no page reload), so a half-written message stays.
 * Resolves once what is on screen has loaded again (or failed to: those
 * failures show where they always do, and the board's reconnect takes over).
 */
export async function refreshBoard(
  queryClient: QueryClient,
  target: Pick<Window, "dispatchEvent"> = window,
): Promise<void> {
  target.dispatchEvent(new Event(BOARD_REFRESH_EVENT));
  void queryClient.invalidateQueries({ type: "inactive", refetchType: "none" });
  await queryClient.refetchQueries({ type: "active" }, { throwOnError: false });
}
