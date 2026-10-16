// pluginConfig.keel in xal's config.json, checked strictly the way xal checks its own sections: a wrong type or an
// unknown field fails the plugin's registration instead of running with half a configuration.

export type KeelConfig = {
  /** keel's api, as this computer reaches it (keel2 status prints it). */
  url: string;
  /** keel's project id; without it the project whose folder holds xal's working directory, else keel's choice. */
  project?: string;
  /** The command that starts keel's MCP server for the slash commands (stdio). */
  mcp: string[];
  /** A short keel brief (flow, phase, what waits, next) in the system prompt of each new session. */
  brief: boolean;
  /** Ask keel's guard before xal's write, edit and bash tools (keel 0.19: a step your session holds). */
  guard: boolean;
  guardCommand: string[];
  /** Per request, in milliseconds. keel_start_flow waits up to 20 s for the first gate. */
  timeoutMs: number;
};

const FIELDS = ["url", "project", "mcp", "brief", "guard", "guardCommand", "timeoutMs"];

export const DEFAULTS: KeelConfig = {
  url: "http://localhost:8080",
  mcp: ["keel2", "mcp", "--admin"],
  brief: true,
  guard: false,
  guardCommand: ["keel2", "hook", "pre-tool"],
  timeoutMs: 60_000,
};

function words(name: string, v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === "string" && x.length > 0)) {
    throw new Error(`pluginConfig.keel.${name} must be a non-empty array of strings (a command and its arguments)`);
  }
  return v as string[];
}

/** The plugin's settings: pluginConfig.keel over KEEL_URL / KEEL_PROJECT over the defaults. */
export function readConfig(raw: Record<string, unknown>, env: Record<string, string | undefined> = {}): KeelConfig {
  const unknown = Object.keys(raw).filter((k) => !FIELDS.includes(k));
  if (unknown.length) throw new Error(`pluginConfig.keel: unknown field ${unknown.join(", ")} (known: ${FIELDS.join(", ")})`);
  const cfg: KeelConfig = { ...DEFAULTS, mcp: [...DEFAULTS.mcp], guardCommand: [...DEFAULTS.guardCommand] };
  const url = raw.url ?? env.KEEL_URL;
  if (url !== undefined) {
    if (typeof url !== "string" || !/^https?:\/\/[^\s]+$/.test(url)) throw new Error("pluginConfig.keel.url must be an http(s) URL");
    cfg.url = url.replace(/\/+$/, "").replace(/\/api$/, "");
  }
  const project = raw.project ?? env.KEEL_PROJECT;
  if (project !== undefined && project !== "") {
    if (typeof project !== "string") throw new Error("pluginConfig.keel.project must be a string");
    cfg.project = project;
  }
  if (raw.mcp !== undefined) cfg.mcp = words("mcp", raw.mcp);
  if (raw.guardCommand !== undefined) cfg.guardCommand = words("guardCommand", raw.guardCommand);
  for (const k of ["brief", "guard"] as const) {
    if (raw[k] === undefined) continue;
    if (typeof raw[k] !== "boolean") throw new Error(`pluginConfig.keel.${k} must be true or false`);
    cfg[k] = raw[k] as boolean;
  }
  if (raw.timeoutMs !== undefined) {
    const t = raw.timeoutMs;
    if (typeof t !== "number" || !Number.isInteger(t) || t < 1000 || t > 600_000) {
      throw new Error("pluginConfig.keel.timeoutMs must be an integer from 1000 to 600000");
    }
    cfg.timeoutMs = t;
  }
  return cfg;
}
