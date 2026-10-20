// The terminal's background, asked once at the start (OSC 11 "what is your background colour?"), so the auto palette
// can become the dark or the light one. A Device Attributes query (DA1) goes right after it: every terminal answers
// that one, so its answer means "no background answer is coming" and nothing is left over for the prompt to read.

/** The reply's colour (rgb:RRRR/GGGG/BBBB, 1 to 4 hex digits each) as dark or light; null when there is none. */
export function parseOsc11(s: string): "dark" | "light" | null {
  const m = /\x1b\]11;rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(s);
  if (!m) return null;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16) / (16 ** h.length - 1));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? "light" : "dark";
}

/** Ask the terminal; at most `ms` milliseconds. null: not a terminal, no answer, or the answer said nothing. */
export function probeBackground(stdin: NodeJS.ReadStream = process.stdin, stdout: NodeJS.WriteStream = process.stdout, ms = 300):
  Promise<"dark" | "light" | null> {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") return Promise.resolve(null);
  return new Promise((resolve) => {
    let buf = "";
    const wasRaw = stdin.isRaw;
    const done = (v: "dark" | "light" | null) => {
      clearTimeout(timer);
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      resolve(v);
    };
    const onData = (d: Buffer | string) => {
      buf += d.toString();
      const v = parseOsc11(buf);
      // the background's answer, or the DA1 answer (ESC [ ? … c) that every terminal gives: either ends the wait
      if (v || /\x1b\[\?[\d;]*c/.test(buf)) done(v);
    };
    const timer = setTimeout(() => done(parseOsc11(buf)), ms);
    stdin.setRawMode(true);
    stdin.on("data", onData);
    stdin.resume();
    stdout.write("\x1b]11;?\x1b\\\x1b[c");
  });
}
