import { AUTOMA_COMPANY, AUTOMA_MAKER } from "@paperclipai/shared";

const JAMAICA_FLAG = "🇯🇲";

/**
 * The credit line (AUTOMA_CREDIT). On a narrow screen it wraps between its
 * parts, never inside one. Its words are written as the board's own ("By
 * {0}", "Made in Jamaica {0}"), so they show in the person's language; the
 * names and the flag are values, kept as they are, and the separators stay
 * outside what is translated.
 */
export function AutomaCredit() {
  return (
    <>
      <span className="whitespace-nowrap"><span>By {AUTOMA_MAKER}</span> ·</span>{" "}
      <span className="whitespace-nowrap">{AUTOMA_COMPANY} ·</span>{" "}
      <span className="whitespace-nowrap">Made in Jamaica {JAMAICA_FLAG}</span>
    </>
  );
}
