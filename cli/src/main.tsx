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
import { renderMarkdown } from "./core/markdown";
import { colorDiagram } from "./core/colorize";
import { applyLevel, makeTheme, PLAIN, type Paint } from "./core/theme";
import { VERSION } from "./core/version";
import { runScript } from "./script";
import { Profiler } from "./core/profile";
import { HELP, parseArgs } from "./main.args";
import { MOUSE, SCREEN, screenStdout } from "./core/lines";

// keel's colours: the dashboard's palette (NO_COLOR, KEEL_TUI_THEME, FORCE_COLOR); -c writes them only into a terminal
const theme = makeTheme();
applyLevel(theme);

function printReply(r: Reply, c: Paint) {
  for (const b of r.blocks) {
    const t = b.kind === "markdown" ? renderMarkdown(b.text, c) : b.kind === "diagram" ? colorDiagram(b.text, c)
      : b.kind === "error" ? c.bad(`error: ${b.text}`) : b.kind === "ok" ? c.ok(b.text) : b.text;
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
  // --profile: the start, each call, the live events, each frame and the memory; a summary and a file on exit
  const profiler = args.profile ? new Profiler() : undefined;
  const done = (code: number) => {
    if (profiler) process.stderr.write(profiler.summary(profiler.save()) + "\n");
    return code;
  };
  const core = new KeelCore({ url: args.url, publicUrl: args.publicUrl, project: args.project, cwd: args.cwd, noLive: oneShot, profiler });
  if (args.script) return done(await runScript(core, args.script, { out: args.out, width: args.width, ansi: args.ansi, theme, profiler, rows: args.rows }));
  if (oneShot) {
    const s = await core.start();
    profiler?.ready();
    if (!s.health) {
      process.stderr.write(`keel is not reachable at ${s.url}: ${s.error}\n`);
      return 1;
    }
    let code = 0;
    const paint = process.stdout.isTTY || process.env.FORCE_COLOR ? theme.paint : PLAIN;
    for (const c of args.commands) {
      const r = await run({ core, width: args.width, paint }, c);
      if (r.chat) {
        const done = new Promise<{ text: string; ok: boolean }>((res) => core.on("answer", (a) => res(a)));
        core.follow();
        await follow("chat", () => core.send(r.chat!).then(() => ({ blocks: [] })));
        const a = await done;
        process.stdout.write(renderMarkdown(a.text, paint) + "\n");
        if (!a.ok) code = 1;
      } else printReply(r, paint);
      if (r.blocks.some((b) => b.kind === "error")) code = 1;
    }
    core.stop();
    return done(code);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("keel-tui needs a terminal. Without one: keel-tui -c \"/status\" or keel-tui --script <file>.\n");
    return 2;
  }
  if (args.inline) {
    const app = render(<App core={core} theme={theme} profiler={profiler} />, { exitOnCtrlC: false });
    await app.waitUntilExit();
    return done(0);
  }
  // the full screen: the terminal's own screen for the app (its scrollback stays as it was), the wheel on; both are
  // given back however keel TUI ends
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    process.stdout.write(MOUSE.off + SCREEN.off);
  };
  process.on("exit", restore);
  process.stdout.write(SCREEN.on + (args.mouse ? MOUSE.on : ""));
  // docker exec -it gives the terminal's size a moment after the start: wait for it (a frame taller than the screen
  // would scroll it), at most 1 s
  if (!process.stdout.rows) await new Promise<void>((done) => {
    const t = setTimeout(done, 1000);
    process.stdout.once("resize", () => (clearTimeout(t), done()));
  });
  const app = render(<App core={core} theme={theme} profiler={profiler} rows={process.stdout.rows || 24} mouse={args.mouse} />,
    { exitOnCtrlC: false, stdout: screenStdout(process.stdout) });
  try {
    await app.waitUntilExit();
  } finally {
    app.clear();
    restore();
  }
  process.stdout.write(`keel TUI closed · keel keeps running at ${core.snapshot.publicUrl}\n`);
  return done(0);
}

main().then((code) => process.exit(code ?? 0), (e) => {
  process.stderr.write(`keel-tui: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
