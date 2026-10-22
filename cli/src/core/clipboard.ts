import { spawn as spawnChild } from "node:child_process";

// keel 0.18.15 /copy: text to the person's clipboard through the terminal (OSC 52). keel TUI often runs inside keel's
// container (keel2 tui → docker exec), where no pbcopy/xclip reaches the person's computer; the terminal does. iTerm2,
// Warp, VS Code, kitty, WezTerm, Alacritty and Windows Terminal accept it; macOS Terminal.app ignores it.

/** The escape sequence that asks the terminal to put `text` on the clipboard (inside tmux: wrapped for passthrough). */
export function osc52(text: string, env: Record<string, string | undefined> = process.env): string {
  const seq = `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
  return env.TMUX ? `\x1bPtmux;${seq.replace(/\x1b/g, "\x1b\x1b")}\x1b\\` : seq;
}

/** Which blocks /copy can take: what keel or KeelBot said, not the person's own lines or keel's dim notes. */
export const COPYABLE = new Set(["text", "markdown", "ok", "error", "diagram", "code", "table"]);

/** The n-th copyable block from the end (1 = the last), or null. */
export function pickCopy<T extends { kind: string; text: string }>(blocks: T[], n: number): T | null {
  const ok = blocks.filter((b) => COPYABLE.has(b.kind) && b.text.trim());
  return ok[ok.length - n] ?? null;
}

/** How to select with the terminal itself while keel TUI has the mouse (iTerm2 and macOS Terminal: Option; most others: Shift). */
export const NATIVE_SELECT = "Option-drag (Shift-drag) for the terminal's own selection";

/** The command that puts text on this computer's clipboard, when keel TUI runs on it (not in keel's container, not
 *  over ssh): pbcopy on a Mac, wl-copy or xclip on a Linux desktop. Null where only the terminal can (OSC 52), and with
 *  KEEL_TUI_CLIPBOARD=terminal (the tests: never the clipboard of the computer they run on). */
export function localCopier(env: Record<string, string | undefined> = process.env, platform: string = process.platform): string[] | null {
  if (env.SSH_CONNECTION || env.SSH_TTY || env.KEEL_TUI_CLIPBOARD === "terminal") return null;
  if (platform === "darwin") return ["pbcopy"];
  if (platform === "linux" && env.WAYLAND_DISPLAY) return ["wl-copy"];
  if (platform === "linux" && env.DISPLAY) return ["xclip", "-selection", "clipboard"];
  return null;
}

/** What copying did: `via` the clipboard command used (null: the terminal's OSC 52 only), and a note when this terminal
 *  is known to ignore OSC 52 and nothing else could copy (macOS Terminal). */
export type Copied = { lines: number; chars: number; via: string | null; note: string | null };

export type Spawn = (cmd: string, args: string[]) => { stdin: { end: (s: string) => void } | null; on: (ev: "error", f: () => void) => unknown };

/** `text` to the person's clipboard: always through the terminal (OSC 52: also through docker exec and ssh), and with
 *  this computer's own clipboard command where there is one (macOS Terminal ignores OSC 52). */
export function copyText(text: string, out: { write: (s: string) => unknown } | undefined, env: Record<string, string | undefined> = process.env,
  platform: string = process.platform, spawn: Spawn = defaultSpawn): Copied {
  out?.write(osc52(text, env));
  const cmd = localCopier(env, platform);
  let via: string | null = null;
  if (cmd) {
    try {
      const child = spawn(cmd[0], cmd.slice(1));
      child.on("error", () => undefined);           // no such command: OSC 52 was sent anyway
      child.stdin?.end(text);
      via = cmd[0];
    } catch {
      via = null;
    }
  }
  const note = !via && env.TERM_PROGRAM === "Apple_Terminal"
    ? "macOS Terminal ignores copy requests: Option-drag selects with the terminal, or /mouse off" : null;
  return { lines: text.split("\n").length, chars: [...text].length, via, note };
}

/** "copied 3 lines (120 characters)" and, when it helps, how to copy with the terminal itself. */
export function copiedText(c: Copied): string {
  const what = c.lines > 1 ? `${c.lines} lines (${c.chars} characters)` : `${c.chars} character${c.chars === 1 ? "" : "s"}`;
  return `copied ${what}${c.note ? ` · ${c.note}` : ""}`;
}

function defaultSpawn(cmd: string, args: string[]) {
  return spawnChild(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
}
