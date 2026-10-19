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
