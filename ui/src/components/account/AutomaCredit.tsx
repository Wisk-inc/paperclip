import { Fragment } from "react";
import { AUTOMA_CREDIT } from "@paperclipai/shared";

/** The credit line. On a narrow screen it wraps between its parts, never inside one. */
export function AutomaCredit() {
  const parts = AUTOMA_CREDIT.split(" · ");
  return parts.map((part, index) => (
    <Fragment key={part}>
      {index ? " " : null}
      <span className="whitespace-nowrap">{index < parts.length - 1 ? `${part} ·` : part}</span>
    </Fragment>
  ));
}
