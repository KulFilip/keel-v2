// keel TUI's transport: keel's address, Node's fetch, and the headers that say who acts. Every request of the web's
// typed client (web/src/api.ts setTransport) carries
//
//   X-Keel-Via: tui                 the api records a write as a tui.call event: "via keel TUI · /approve"
//   X-Keel-Client: keel TUI 0.17.3
//   X-Keel-Tool: /approve           the command that sent it (set by the command runner)
import { setTransport } from "./sdk";
import { VERSION } from "./version";

let command = "";

/** The command that runs now: its requests say so (X-Keel-Tool). */
export function setCommand(name: string) {
  command = name;
}

export function viaHeaders(): Record<string, string> {
  return { "X-Keel-Via": "tui", "X-Keel-Client": `keel TUI ${VERSION}`, ...(command ? { "X-Keel-Tool": command.slice(0, 80) } : {}) };
}

/** keel's base URL without a trailing slash or /api: http://localhost:8080 */
export function normalizeUrl(url: string): string {
  let u = url.trim();
  if (!/^https?:\/\//.test(u)) u = "http://" + u;
  return u.replace(/\/+$/, "").replace(/\/api$/, "");
}

/** Point the web's client at keel: from here on api.*, inboxApi.* and kb.* talk to `url`. */
export function connect(url: string, f: typeof fetch = fetch): string {
  const base = normalizeUrl(url);
  setTransport({ base, headers: viaHeaders, fetch: f });
  return base;
}
