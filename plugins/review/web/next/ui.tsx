// Small pieces of the new Review view: the status pill (a dot and a word, the colour says the state).

import type { ReactNode } from "react";
import type { Tone } from "./model";

export function Tag({
  tone,
  children,
  title,
}: {
  tone: Tone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`rvn-tag t-${tone}`} title={title}>
      <span className="rvn-tag-dot" aria-hidden="true" />
      {children}
    </span>
  );
}
