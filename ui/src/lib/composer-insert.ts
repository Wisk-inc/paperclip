/** Puts text into the open chat's message box (conversation starters, suggestions). */
export const COMPOSER_INSERT_EVENT = "automa:composer-insert";

export function insertIntoComposer(text: string) {
  window.dispatchEvent(new CustomEvent<{ text: string }>(COMPOSER_INSERT_EVENT, { detail: { text } }));
}
