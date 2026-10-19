// keel-tui's command line: its options and help (main.tsx runs it; tests read it without starting the app).
import { VERSION } from "./core/version";

export const HELP = `keel-tui ${VERSION}: keel v2 in the terminal (KeelBot, slash commands, the live flow, agents and inbox)

  keel-tui [options]              the app (needs a terminal)
  keel-tui -c "/status" [-c …]    run commands, print the answers as text, leave
  keel-tui --script <file>        drive the app from a file (--out <dir> saves the @snap captures, --ansi with colours too)

options
  --url <url>          keel's address (KEEL_URL, default http://localhost:8080)
  --public-url <url>   the dashboard's address for links (KEEL_PUBLIC_URL, default --url)
  --project <id>       the project (KEEL_PROJECT; default: the one this folder is in, else the first)
  --cwd <dir>          the folder that picks the project (KEEL_TUI_CWD, default this one)
  --inline             no full screen: the transcript goes into the terminal's scrollback (KEEL_TUI_INLINE=1)
  --no-mouse           the mouse stays the terminal's (its own selection; PgUp / PgDn scroll) (KEEL_TUI_MOUSE=0);
                       with the mouse on, the wheel scrolls and selecting text copies it
  --width <n>          columns for -c and --script (default 100)
  --rows <n>           --script on a full screen of n rows (default: inline)
  --profile            time the start, each api call, the live events and each frame, and the memory; on exit a summary
                       and a JSON file (KEEL_TUI_PROFILE_DIR, else ~/.local/state/keel2/tui-profiles): nothing leaves this computer
  --version, --help`;

export type Args = { url: string; publicUrl?: string; project?: string; cwd: string; commands: string[]; script?: string; out?: string; width: number; ansi?: boolean; profile?: boolean;
  inline: boolean; mouse: boolean; rows?: number };

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): Args | "help" | "version" {
  const a: Args = { url: env.KEEL_URL || "http://localhost:8080", publicUrl: env.KEEL_PUBLIC_URL || undefined, project: env.KEEL_PROJECT || undefined,
    cwd: env.KEEL_TUI_CWD || process.cwd(), commands: [], width: 100,
    inline: env.KEEL_TUI_INLINE === "1", mouse: env.KEEL_TUI_MOUSE !== "0" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new Error(`${k} needs a value`);
      return x;
    };
    if (k === "--help" || k === "-h") return "help";
    if (k === "--version" || k === "-v") return "version";
    if (k === "--url") a.url = v();
    else if (k === "--public-url") a.publicUrl = v();
    else if (k === "--project") a.project = v();
    else if (k === "--cwd") a.cwd = v();
    else if (k === "-c" || k === "--command") a.commands.push(v());
    else if (k === "--script") a.script = v();
    else if (k === "--out") a.out = v();
    else if (k === "--ansi") a.ansi = true;
    else if (k === "--profile") a.profile = true;
    else if (k === "--inline") a.inline = true;
    else if (k === "--no-mouse") a.mouse = false;
    else if (k === "--rows") a.rows = Math.max(12, Number(v()) || 40);
    else if (k === "--width") a.width = Math.max(60, Number(v()) || 100);
    else throw new Error(`unknown option ${k} (keel-tui --help)`);
  }
  return a;
}

