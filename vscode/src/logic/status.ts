// The status bar's words (pure, for the unit tests).

/** The status bar text: questions first, else the running flow's phase, else plain keel. */
export function statusText(s: { connected: boolean; hasError: boolean; questions: number; runningPhase?: string }): string {
  if (!s.connected) return s.hasError ? "◆ keel: offline" : "◆ keel";
  if (s.questions === 1) return "◆ keel: 1 question";
  if (s.questions > 1) return `◆ keel: ${s.questions} questions`;
  if (s.runningPhase) return `◆ keel: ${s.runningPhase}`;
  return "◆ keel";
}
