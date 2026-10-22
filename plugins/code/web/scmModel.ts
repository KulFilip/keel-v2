// Source control's small rules, pure (no React): the ticket key in a branch name, the branch name split into its
// folder prefix and the rest, the search that also finds ticket keys, and when a branch is stale.

/** A ticket key anywhere in a branch name or a commit subject: ERPDM-1769, ABC2-7. Used when no team pattern is set. */
export const GENERIC_TICKET = "[A-Z][A-Z0-9]+-\\d+";

/** The regex for a ticket pattern, bounded so ABC-12 is not found inside XABC-123; null when the pattern does not
 *  compile here (a team's pattern is written for the api's Java regex, nearly always the same). */
export function ticketRegex(pattern: string = GENERIC_TICKET): RegExp | null {
  try {
    return new RegExp(
      `(?<![A-Za-z0-9])(?:${pattern})(?![0-9])`,
      pattern === GENERIC_TICKET ? "g" : "gi",
    );
  } catch {
    return null;
  }
}

/** The first ticket key in `text`, upper case, or null. The generic pattern is case sensitive (a key is upper case;
 *  "fix-2" is not a ticket), a team's pattern is not (keel's api reads it the same way). */
export function ticketKey(
  text: string | null | undefined,
  pattern?: string | null,
): string | null {
  if (!text) return null;
  const r =
    ticketRegex(pattern || GENERIC_TICKET) ?? ticketRegex(GENERIC_TICKET)!;
  const m = text.match(r);
  return m ? m[0].toUpperCase() : null;
}

/** "feature/ERPDM-1-x" -> { prefix: "feature/", rest: "ERPDM-1-x" }; a name without "/" has no prefix. */
export function splitBranch(name: string): { prefix: string; rest: string } {
  const i = name.lastIndexOf("/");
  return i > 0 && i < name.length - 1
    ? { prefix: name.slice(0, i + 1), rest: name.slice(i + 1) }
    : { prefix: "", rest: name };
}

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Does a branch match what the person typed: its name (any case), or the name without - _ / . (erpdm1769 finds
 *  ERPDM-1769-x), or a ticket key in its last commit's subject. */
export function branchMatches(
  name: string,
  note: string | undefined,
  q: string,
): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  if (name.toLowerCase().includes(needle)) return true;
  const c = compact(needle);
  if (c.length >= 3 && compact(name).includes(c)) return true;
  const key = ticketKey(note);
  return !!key && c.length >= 3 && compact(key).includes(c);
}

export const STALE_DAYS = 14;

/** No commit in the last 14 days. A date that does not parse is not stale. */
export function isStale(
  date: string | null | undefined,
  now = Date.now(),
): boolean {
  const t = date ? Date.parse(date) : NaN;
  return Number.isFinite(t) && now - t > STALE_DAYS * 86_400_000;
}

/** "2 days ago", "3 weeks ago" for a branch's last commit. */
export function ageOf(
  date: string | null | undefined,
  now = Date.now(),
): string {
  const t = date ? Date.parse(date) : NaN;
  if (!Number.isFinite(t)) return "";
  const days = Math.floor((now - t) / 86_400_000);
  if (days < 1) return "today";
  if (days < 14) return `${days} day${days === 1 ? "" : "s"} ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}

/** Side bar widths: the default side bar and Source control's own (a wider default; both remembered per browser). */
export const SIDE_MIN = 200;
export const SIDE_MAX = 900;
export const SCM_DEFAULT = 380;
export const SCM_MIN = 280;

/** A width kept inside [min, max] and inside the window: the editor keeps at least 320 px. */
export function clampSide(w: number, min: number, room: number): number {
  const max = Math.max(min, Math.min(SIDE_MAX, room - 320));
  return Math.round(Math.min(max, Math.max(min, Number.isFinite(w) ? w : min)));
}
