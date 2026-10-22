// v0.9.0 KeelBot's buttons (v0.10.0: keel-query and keel-git from the Database and Git plugins: QueryCard, GitCard).
// An answer may end with action blocks (the plugin's engine, keel_plugin_keelbot/keelbot.py): ```keel-start {json}```
// becomes a card that starts a flow when the person presses Start; ```keel-workflow <yaml>``` becomes a card that keel
// checks (POST …/workflows/check) and the person saves (POST …/workflows/import, into a folder if they like). Nothing
// starts or is saved without a press.
// Since step 3 a block of a kind no core card handles is a plugin's card, from the slot keelbot.card (SlotCard below):
// the Database plugin's ```keel-query``` (plugins/db/web/QueryCard.tsx) and the Git plugin's ```keel-git```
// (plugins/git/web/GitCard.tsx), so KeelBot imports no plugin.

export type Segment =
  { kind: "text"; text: string } | { kind: "start" | "workflow" | "query" | "git" | "ci" | "flow" | "rule" | "agent" | "skill" | "stack" | "questions"; body: string };

const ACTION = /^\s*(`{3,}|~{3,})\s*keel-(start|workflow|query|git|ci|flow|rule|agent|skill|stack|questions)\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const closes = (line: string, open: string) => {
  const t = line.trim();
  return t.length >= open.length && t === open[0].repeat(t.length);
};

/** The answer as text and action blocks, in order. A keel block inside another code block stays text. */
export function splitActions(text: string): Segment[] {
  const lines = (text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: Segment[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (buf.join("\n").trim()) out.push({ kind: "text", text: buf.join("\n") });
    buf = [];
  };
  let i = 0;
  while (i < lines.length) {
    const a = lines[i].match(ACTION);
    if (a) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !closes(lines[i], a[1])) body.push(lines[i++]);
      i++;
      flush();
      out.push({
        kind: a[2] as Exclude<Segment["kind"], "text">,
        body: body.join("\n"),
      });
      continue;
    }
    const f = lines[i].match(FENCE);
    buf.push(lines[i++]);
    if (f) {
      while (i < lines.length && !closes(lines[i], f[1])) buf.push(lines[i++]);
      if (i < lines.length) buf.push(lines[i++]);
    }
  }
  flush();
  return out;
}

export { StartCard } from "./StartCard";
export { WorkflowCard } from "./WorkflowCard";
export { CiCard } from "./CiCard";
export { FlowCard } from "./FlowCard";
export { RuleCard } from "./RuleCard";
export { AgentCard } from "./AgentCard";
export { SkillCard, skillHead } from "./SkillCard";
export { StackCard } from "./StackCard";
export { QuestionsCard } from "./QuestionsCard";
export { SlotCard } from "./SlotCard";
