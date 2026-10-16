#!/usr/bin/env node
// keel-tui: keel v2 in the terminal. `keel2` (no arguments, in a terminal) and `keel2 tui` start it; so does the npm
// bin. docs/plans/keel-tui.md says what it does.
//
//   keel-tui [--url http://localhost:8080] [--project <id>] [--public-url <dashboard url>]
//   keel-tui -c "/status"            run commands (one per -c), print their answers as text, leave
//   keel-tui --script <file> [--out <dir>] [--width 100]    drive the app from a file (src/script.ts)

import React from "react";
import { render } from "ink";
import { App } from "./ui/App";
import { KeelCore } from "./core/keel";
import { run, follow, type Reply } from "./core/commands";
import { renderMarkdown, plain } from "./core/markdown";
import { VERSION } from "./core/version";
import { runScript } from "./script";
import { HELP, parseArgs } from "./main.args";

function printReply(r: Reply) {
  for (const b of r.blocks) {
    const t = b.kind === "markdown" ? renderMarkdown(b.text, plain) : b.kind === "error" ? `error: ${b.text}` : b.text;
    process.stdout.write(t + "\n");
  }
  if (r.pick) process.stdout.write(`${r.pick.title}\n${r.pick.choices.map((c, i) => `  ${i + 1}. ${c.label}${c.hint ? `  (${c.hint})` : ""}`).join("\n")}\n`);
  if (r.ask) process.stdout.write(`${r.ask.prompt} (give it in the command: keel-tui -c "/… <words>")\n`);
}

async function main(): Promise<number> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  if (args === "help") return void process.stdout.write(HELP + "\n"), 0;
  if (args === "version") return void process.stdout.write(`keel-tui ${VERSION}\n`), 0;
  const oneShot = args.commands.length > 0;
  const core = new KeelCore({ url: args.url, publicUrl: args.publicUrl, project: args.project, cwd: args.cwd, noLive: oneShot });
  if (args.script) return runScript(core, args.script, { out: args.out, width: args.width });
  if (oneShot) {
    const s = await core.start();
    if (!s.health) {
      process.stderr.write(`keel is not reachable at ${s.url}: ${s.error}\n`);
      return 1;
    }
    let code = 0;
    for (const c of args.commands) {
      const r = await run({ core, width: args.width }, c);
      if (r.chat) {
        const done = new Promise<{ text: string; ok: boolean }>((res) => core.on("answer", (a) => res(a)));
        core.follow();
        await follow("chat", () => core.send(r.chat!).then(() => ({ blocks: [] })));
        const a = await done;
        process.stdout.write(renderMarkdown(a.text, plain) + "\n");
        if (!a.ok) code = 1;
      } else printReply(r);
      if (r.blocks.some((b) => b.kind === "error")) code = 1;
    }
    core.stop();
    return code;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("keel-tui needs a terminal. Without one: keel-tui -c \"/status\" or keel-tui --script <file>.\n");
    return 2;
  }
  const app = render(<App core={core} />, { exitOnCtrlC: false });
  await app.waitUntilExit();
  return 0;
}

main().then((code) => process.exit(code ?? 0), (e) => {
  process.stderr.write(`keel-tui: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
