// What the four marketplace clients (workflows, rule packs, skills, stacks) and their pages share. No React, no DOM.

export const e = encodeURIComponent;

/** `{a: "1", b: ""}` → "?a=1" (empty values are left out). */
export const query = (p: Record<string, string | null | undefined>) => {
  const s = new URLSearchParams(Object.entries(p).filter((x): x is [string, string] => !!x[1])).toString();
  return s ? `?${s}` : "";
};

/** Why keel would not install a thing (the catalog's own words). */
export type Refusal = { error: string; hint?: string };

export const refusedText = (r: Refusal | null) => (r ? [r.error, r.hint].filter(Boolean).join(" ") : "");

/** An error as the pages show it (message, hint, details). */
export type Err = { message: string; hint?: string; details?: string[] } | null;
