// 0.18.18 /editor: the prompt in the person's own editor ($VISUAL, else $EDITOR), and what they saved back in the
// prompt. No UI here: keel TUI hands the terminal to the editor while it runs (core keeps nothing of it).
import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";

export type Editor = { cmd: string; args: string[]; name: string };

const runnable = (p: string) => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Is this command there to run: a path that can run, or a name on PATH. */
export function onPath(cmd: string, env: Record<string, string | undefined> = process.env): boolean {
  if (cmd.includes("/")) return runnable(cmd);
  return (env.PATH ?? "").split(delimiter).some((d) => d && runnable(join(d, cmd)));
}

/** The person's editor: $VISUAL, else $EDITOR (a command and its words, as `code -w`), when it is on PATH; else why
 *  there is none, in words for the person. */
export function findEditor(env: Record<string, string | undefined>, there: (cmd: string) => boolean = (c) => onPath(c, env)):
  { editor: Editor } | { why: string } {
  const named = [["VISUAL", env.VISUAL], ["EDITOR", env.EDITOR]].filter((x): x is [string, string] => !!x[1]?.trim());
  if (!named.length) return { why: "no editor: set $VISUAL or $EDITOR (for example export EDITOR=nano), then /editor again." };
  for (const [, value] of named) {
    const [cmd, ...args] = value.trim().split(/\s+/);
    if (there(cmd)) return { editor: { cmd, args, name: basename(cmd) } };
  }
  const [v, value] = named[0];
  const cmd = value.trim().split(/\s+/)[0];
  return { why: `no editor: $${v} is ${cmd}, but ${cmd} is not on PATH.` };
}

/** Open `text` in the editor (the terminal is the editor's until it ends) and answer what it saved, without its last
 *  newline. A failed editor (not 0) answers an error with what it said. */
export function editText(text: string, ed: Editor, run: typeof spawnSync = spawnSync): { text: string } | { error: string } {
  const dir = mkdtempSync(join(tmpdir(), "keel-prompt-"));
  const file = join(dir, "prompt.md");
  try {
    writeFileSync(file, text);
    const r = run(ed.cmd, [...ed.args, file], { stdio: "inherit" });
    if (r.error) return { error: `${ed.name} did not start: ${r.error.message}` };
    if (r.status !== 0) return { error: `${ed.name} ended with ${r.status ?? r.signal}: the prompt is as it was.` };
    return { text: readFileSync(file, "utf8").replace(/\r?\n$/, "") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
