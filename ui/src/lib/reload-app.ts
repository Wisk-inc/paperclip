/**
 * Loads the whole board again from the server: the account sheet's "Reload
 * app", for a page that looks stuck in a way Refresh (data only) can't fix.
 * Its own module so tests can stand in for it.
 */
export function reloadApp(): void {
  window.location.reload();
}
