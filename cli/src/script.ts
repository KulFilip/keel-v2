// keel-tui --script <file>: drive the real app without a person, through its own keyboard. Each line of the file is
// typed into the prompt (then Enter); lines that start with @ steer the run:
//
//   @snap <name>             save what the terminal shows now (ANSI removed), from where the capture before ends,
//                            as <out>/<name>.txt (or print it); with --ansi also <out>/<name>.ansi, colours kept
//   @wait started|idle|waiting|answer|pick|ask|running|streaming [seconds]   wait for the app or the flow (default 120 s)
//   @key tab|enter|esc|up|down|ctrl+f|ctrl+a|ctrl+b|ctrl+g  press a key
//   @type <text>             type without Enter;  @paste <n>   paste n lines at once
//   @sleep <ms>              wait
//   # …                      a comment
//
// Used by scripts/test-keel-tui.sh against a throw-away keel; the captures go to docs/pictures/tui/.

import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { render } from "ink";
import { App, type Probe } from "./ui/App";
import type { KeelCore } from "./core/keel";
import type { Theme } from "./core/theme";
import type { Profiler } from "./core/profile";

export const KEYS: Record<string, string> = {
  tab: "\t", enter: "\r", esc: "\x1b", up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C", backspace: "\x7f",
  "ctrl+f": "\x06", "ctrl+a": "\x01", "ctrl+b": "\x02", "ctrl+g": "\x07", "ctrl+u": "\x15", "ctrl+c": "\x03",
};

export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[=>]/g, "");

/** A stdin Ink can read keys from (the same shape as ink-testing-library's). */
export class FakeStdin extends EventEmitter {
  isTTY = true;
  private data: string | null = null;
  write(data: string) {
    this.data = data;
    this.emit("readable");
    this.emit("data", data);
  }
  read() {
    const d = this.data;
    this.data = null;
    return d;
  }
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
}

/** A stdout that keeps the last frame Ink wrote (debug mode writes the whole screen each time). */
export class FakeStdout extends EventEmitter {
  frames = 0;
  last = "";
  constructor(public columns: number, public rows = 1000) {
    super();
  }
  write(s: string) {
    this.last = s;
    this.frames++;
    return true;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, seconds: number, what: string, tick?: () => void): Promise<void> {
  const end = Date.now() + seconds * 1000;
  let n = 0;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out after ${seconds}s waiting for ${what}`);
    await sleep(250);
    if (tick && ++n % 8 === 0) tick();
  }
}

export async function runScript(core: KeelCore, file: string, opts: { out?: string; width: number; log?: (s: string) => void; ansi?: boolean;
  theme?: Theme; profiler?: Profiler }): Promise<number> {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout(opts.width);
  const probe: Probe = { started: false, busy: false, pick: false, ask: false, chatBusy: false, answers: 0 };
  const log = opts.log ?? ((s: string) => process.stderr.write(s + "\n"));
  const app = render(React.createElement(App, { core, probe, width: opts.width, theme: opts.theme, profiler: opts.profiler }), {
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, stderr: stdout as unknown as NodeJS.WriteStream,
    debug: true, exitOnCtrlC: false, patchConsole: false,
  });
  const idle = () => !probe.busy;
  // each capture holds what is new since the one before (the transcript only grows), the first one the whole screen
  let before: string[] = [];
  const snap = (name: string) => {
    const lines = stripAnsi(stdout.last).split("\n").map((l) => l.replace(/\s+$/, ""));
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    let same = 0;
    while (same < lines.length && same < before.length && lines[same] === before[same]) same++;
    before = lines;
    const text = (same > 0 ? `… (${same} lines above: the capture before)\n` : "") + lines.slice(same).join("\n") + "\n";
    // --ansi: the same lines with keel's colours kept (view them with cat or less -R)
    const raw = stdout.last.split("\n").map((l) => l.replace(/\s+$/, ""));
    const colours = (same > 0 ? `… (${same} lines above: the capture before)\n` : "") + raw.slice(same, lines.length).join("\n") + "\x1b[0m\n";
    if (opts.out) {
      mkdirSync(opts.out, { recursive: true });
      writeFileSync(join(opts.out, `${name}.txt`), text);
      if (opts.ansi) writeFileSync(join(opts.out, `${name}.ansi`), colours);
      log(`snap ${name} -> ${join(opts.out, `${name}.txt`)}`);
    } else process.stdout.write(`===== ${name} =====\n${text}`);
  };
  let failed = 0;
  let sent = 0;
  try {
    await until(() => probe.started, 60, "keel TUI to start");
    await sleep(300);
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      const line = raw.replace(/\s+$/, "");
      if (!line || line.startsWith("#")) continue;
      log(`> ${line}`);
      const [cmd, a1, a2] = line.split(/\s+/);
      try {
        if (cmd === "@snap") snap(a1 || `snap-${stdout.frames}`);
        else if (cmd === "@sleep") await sleep(Number(a1) || 500);
        else if (cmd === "@paste") {
          // a paste of N lines of code, as a terminal delivers it (one chunk); the app keeps it behind a placeholder
          const n = Number(a1) || 20;
          stdin.write(Array.from({ length: n }, (_, i) => `    value_${i} = compute(${i})  # line ${i + 1}`).join("\n") + "\n");
          await sleep(200);
        } else if (cmd === "@type") {
          // text typed without Enter (an @mention, then Tab)
          stdin.write(line.slice("@type ".length));
          await sleep(500);
        } else if (cmd === "@key") {
          if (a1 === "enter") sent = probe.answers;
          stdin.write(KEYS[a1] ?? a1);
          await sleep(200);
        } else if (cmd === "@wait") {
          const secs = Number(a2) || 120;
          if (a1 === "started") await until(() => probe.started, secs, "start");
          else if (a1 === "idle") await until(() => idle() && !probe.chatBusy, secs, "idle");
          else if (a1 === "pick") await until(() => probe.pick, secs, "a choice");
          else if (a1 === "ask") await until(() => probe.ask, secs, "a question");
          // the answer to what was sent last (a line typed, or Enter): one more answer than then, and the turn over
          else if (a1 === "answer") await until(() => !probe.chatBusy && probe.answers > sent, secs, "KeelBot's answer");
          else if (a1 === "waiting") await until(() => core.snapshot.flow?.thread?.status === "waiting", secs, "the flow to wait at a gate", () => void core.refresh());
          else if (a1 === "running") await until(() => core.snapshot.running.length > 0, secs, "an agent", () => void core.refresh());
          // KeelBot is writing: some of its answer is on screen, the turn has not ended
          else if (a1 === "streaming") await until(() => core.snapshot.chat.busy && core.snapshot.chat.stream.length > 20, secs, "KeelBot's text");
          else throw new Error(`no @wait ${a1}`);
          await sleep(400);
        } else {
          // type it, then Enter
          stdin.write(line);
          await sleep(60);
          sent = probe.answers;
          stdin.write("\r");
          await sleep(150);
          await until(idle, 300, `${line} to finish`);
          await sleep(400);
        }
      } catch (e) {
        failed++;
        log(`! ${line}: ${e instanceof Error ? e.message : String(e)}`);
        snap(`error-${failed}`);
      }
    }
  } finally {
    app.unmount();
    core.stop();
  }
  return failed ? 1 : 0;
}
