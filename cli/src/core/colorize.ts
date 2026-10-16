// keel's ASCII diagrams (engine keel_engine/diagrams.py, plain text) in keel's colours, for a terminal: the step that
// runs in the accent colour, done steps green, a gate that waits amber, a failed one red; ER keys and boxes tinted.
// The text stays the same character for character: only colour is added (PLAIN changes nothing).

import type { Paint } from "./theme";

type Rule = [RegExp, (m: string, p: Paint) => string];

const RULES: Rule[] = [
  [/\[x\]/g, (m, p) => p.ok(m)],
  [/\[>\]/g, (m, p) => p.bold(p.accent(m))],
  [/\[\?\]/g, (m, p) => p.gate(m)],
  [/\[!\]/g, (m, p) => p.bad(m)],
  [/\[#\]|\[-\]/g, (m, p) => p.faint(m)],
  [/\[ \]/g, (m, p) => p.dim(m)],
  [/\[\+\]/g, (m, p) => p.type(m)],
  [/\[[xrg>]\](?=[\w-])/g, (m, p) => p.dim(m)],
  [/<-- waiting for you/g, (m, p) => p.bold(p.gate(m))],
  [/<-- now/g, (m, p) => p.bold(p.accent(m))],
  [/<-- (failed|stopped) here/g, (m, p) => p.bad(m)],
  [/\(loops back\)|\(taken\)/g, (m, p) => p.faint(m)],
  [/\bid=[\w./-]+/g, (m, p) => p.faint(m)],
  [/ -> | --> /g, (m, p) => p.faint(m)],
  [/\bPK\b/g, (m, p) => p.gate(m)],
  [/\bFK\b/g, (m, p) => p.run(m)],
  [/\bUQ\b|\bnot null\b/g, (m, p) => p.attr(m)],
  [/\(gate, you decide\)/g, (m, p) => p.gate(m)],
  [/\(agent [\w-]+\)|\(agent\)/g, (m, p) => p.dim(m)],
  [/\(code[^)]*\)|\(parallel[^)]*\)|\(branch\)/g, (m, p) => p.faint(m)],
];

function line(l: string, p: Paint): string {
  // section headers, legend and the labels of the flow's head
  let m: RegExpExecArray | null;
  if ((m = /^(\s*)(== .* ==)(.*)$/.exec(l))) return m[1] + p.bold(p.accent(m[2])) + p.faint(m[3]);
  if (/^\[x\] done {2}|^ o {2}agent {3}/.test(l)) return p.dim(l);
  if ((m = /^(waiting|answer)(\s+)(.*)$/.exec(l))) return p.bold(p.gate(m[1])) + m[2] + p.gate(m[3]);
  if ((m = /^(flow|workflow|criteria \d+\/\d+:|usage|error)(\s+)(.*)$/.exec(l))) {
    const head = m[1] === "error" ? p.bad(m[1]) : p.accent(m[1]);
    return head + m[2] + (m[1] === "error" ? p.bad(m[3]) : paintTokens(m[3], p));
  }
  if (/^(relations|links|where|used by .*|uses .*|and through them|used two steps away by):$/.test(l)) return p.accent(l);
  if (/^\s*\+-/.test(l) || /^\s*\+-+\+\s*$/.test(l)) return boxes(l, p);
  if (/^\s*\|/.test(l) && /\|\s*$/.test(l)) return boxes(l, p);
  if (/^\.\.\. \d+ more/.test(l)) return p.faint(l);
  return paintTokens(l, p);
}

/** ER and map boxes: the frame faint, the table's name bright, the rows coloured by their tokens. */
function boxes(l: string, p: Paint): string {
  return l.replace(/\+- ([^+]*?) -+\+|\+-+\+|\| ([^|]*?)\s*\|/g, (whole, title?: string, row?: string) => {
    if (title !== undefined) return p.faint("+- ") + p.bold(title) + p.faint(whole.slice(3 + title.length));
    if (row !== undefined) return p.faint("|") + paintTokens(whole.slice(1, -1), p) + p.faint("|");
    return p.faint(whole);
  });
}

function paintTokens(s: string, p: Paint): string {
  // one pass: at each position the first rule that matches wins; the rest of the text is left as it is
  const marks: { at: number; end: number; out: string }[] = [];
  for (const [re, fn] of RULES) {
    re.lastIndex = 0;
    for (const m of s.matchAll(re)) {
      const at = m.index ?? 0;
      const end = at + m[0].length;
      if (marks.some((x) => at < x.end && end > x.at)) continue;
      marks.push({ at, end, out: fn(m[0], p) });
    }
  }
  marks.sort((a, b) => a.at - b.at);
  let out = "";
  let i = 0;
  for (const x of marks) {
    out += s.slice(i, x.at) + x.out;
    i = x.end;
  }
  return out + s.slice(i);
}

/** A whole diagram, line by line. */
export function colorDiagram(text: string, p: Paint): string {
  if (!p.colored) return text;
  return text.split("\n").map((l) => line(l, p)).join("\n");
}
