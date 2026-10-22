// Small pieces of the Ink app's screen drawn from plain values (no state): the prompt's rows and a diff in the live area.

import React from "react";
import { Text } from "ink";
import { promptRows } from "../core/prompt";
import { renderDiff } from "../core/diff";
import type { Paint } from "../core/theme";
import type { useTheme } from "./theme";

type Th = ReturnType<typeof useTheme>;

/** 0.18.18 The prompt's rows (it grows with Alt+Enter up to PROMPT_ROWS rows, then shows the cursor's), the cursor
 *  inverse, and how many rows are hidden above or below. */
export function promptView(t: Th, line: string, cursor: number) {
  const pv = promptRows(line, cursor);
  // 0.18.18 `!` at the start: a shell command keel runs in the project folder (as opencode's shell mode, MIT)
  const shellLine = line.startsWith("!");
  const more = (n: number, where: string) => (
    <Text {...t.look("dim")} wrap="truncate-end">{`  ${n} more line${n === 1 ? "" : "s"} ${where}`}</Text>
  );
  return (
    <>
      {pv.above > 0 && more(pv.above, "above")}
      {pv.rows.map((r, i) => (
        <Text key={pv.above + i}>
          <Text {...t.look(shellLine ? "warn" : "person")} bold>{pv.above + i === 0 ? (shellLine ? "shell › " : "› ") : shellLine ? "        " : "  "}</Text>
          {r.cursor === null ? inputText(t, line, r.text || " ")
            : <>{inputText(t, line, r.text.slice(0, r.cursor))}<Text inverse>{r.text[r.cursor] ?? " "}</Text>{inputText(t, line, r.text.slice(r.cursor + 1))}</>}
        </Text>
      ))}
      {pv.below > 0 && more(pv.below, "below")}
    </>
  );
}

/** The prompt's text: a command's name in the accent colour while it is typed. */
function inputText(t: Th, line: string, x: string) {
  const m = /^(\/\S*)(.*)$/s.exec(x);
  if (!m || x !== line.slice(0, x.length) || !line.startsWith("/")) return <Text>{x}</Text>;
  return <><Text {...t.look("accent")} bold>{m[1]}</Text><Text>{m[2]}</Text></>;
}

/** A change as KeelBot makes it: its diff with line numbers, the first 12 lines. */
export const diffLines = (d: string, paint: Paint) => {
  const all = renderDiff(d.replace(/\n$/, ""), paint).filter((l) => !/(---|\+\+\+) /.test(l.replace(/\x1b\[[0-9;]*m/g, "").trimStart()));
  return all.length > 12 ? [...all.slice(0, 12), paint.faint(`… ${all.length - 12} more lines`)] : all;
};
