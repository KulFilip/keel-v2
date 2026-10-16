// One keel connection per xal process: keel's MCP server (started on the first command, closed at shutdown), the
// REST client, the project, the live notices and the KeelBot chat.

import { briefText, pickProject, type Project } from "./brief.ts";
import type { KeelConfig } from "./config.ts";
import { McpClient, processTransport, type Elicit, type Transport } from "./mcp.ts";
import { noticeFor } from "./notices.ts";
import { KeelRest, type Fetch } from "./rest.ts";
import { follow } from "./sse.ts";

export type Out = {
  print(text: string): void;
  busy?(label?: string): void;
  ask?(question: string): Promise<string | undefined>;
};

export type KeelDeps = {
  cwd: string;
  version: string;
  /** keel's MCP server; a child process by default */
  transport?: (command: string[]) => Transport;
  fetch?: Fetch;
};

export class Keel {
  readonly cfg: KeelConfig;
  readonly rest: KeelRest;
  readonly client: string;
  private readonly deps: KeelDeps;
  private mcp: Promise<McpClient> | undefined;
  private project: Promise<Project | undefined> | undefined;
  private watching: AbortController | undefined;
  /** The brief for new sessions, read once at start (bootstrap). */
  brief = "";
  /** This process's KeelBot chat (/keel:ask), kept between questions. */
  chat: string | undefined;
  private elicitOut: Out | undefined;

  constructor(cfg: KeelConfig, deps: KeelDeps) {
    this.cfg = cfg;
    this.deps = deps;
    this.client = `xal ${deps.version} (keel plugin)`;
    this.rest = new KeelRest(cfg.url, this.client, Math.min(cfg.timeoutMs, 30_000), deps.fetch);
  }

  /** keel's MCP server, started once; a failed start is forgotten so the next command tries again. */
  server(): Promise<McpClient> {
    if (!this.mcp) {
      const elicit: Elicit = async (message, schema) => {
        const out = this.elicitOut;
        if (!out?.ask) return { action: "decline" };
        let answer: string | undefined;
        try {
          answer = (await out.ask(`${message} (yes/no)`))?.trim().toLowerCase();
        } catch {
          out.print(`keel: "${message}" needs your yes, and this shell cannot ask (no terminal). Run it in a terminal or in xal's TUI.`);
          return { action: "decline" };
        }
        if (answer !== "y" && answer !== "yes") return { action: "decline" };
        const props = (schema.properties ?? {}) as Record<string, { type?: string }>;
        const content = Object.fromEntries(Object.entries(props).filter(([, p]) => p.type === "boolean").map(([k]) => [k, true]));
        return { action: "accept", content };
      };
      const transport = (this.deps.transport ?? ((c) => processTransport(c)))(this.cfg.mcp);
      const client = new McpClient(transport, { name: this.client, version: this.deps.version }, this.cfg.timeoutMs, elicit);
      this.mcp = client.start().then(
        () => client,
        (err: unknown) => {
          this.mcp = undefined;
          client.close();
          const why = err instanceof Error ? err.message : String(err);
          throw new Error(
            `keel: could not start keel's MCP server (${this.cfg.mcp.join(" ")}): ${why.replace(/^keel's MCP server stopped: /, "")}\n` +
              "  Is keel running (keel2 status) and keel2 on PATH? pluginConfig.keel.mcp sets the command.",
          );
        },
      );
    }
    return this.mcp;
  }

  /** Calls one of keel's MCP tools for this project; says plainly when this server's level does not offer it. */
  async tool(name: string, args: Record<string, unknown>, out: Out): Promise<string> {
    const server = await this.server();
    const tools = await server.tools();
    if (!tools.has(name)) {
      throw new Error(
        `keel's MCP server does not offer ${name} (its level is too low, or this keel is older). ` +
          `The plugin starts it with: ${this.cfg.mcp.join(" ")}; set pluginConfig.keel.mcp to ["keel2", "mcp", "--admin"].`,
      );
    }
    this.elicitOut = out;
    try {
      const project = args.project === undefined ? await this.projectId() : args.project;
      return await server.call(name, { ...args, project });
    } finally {
      this.elicitOut = undefined;
    }
  }

  async has(name: string): Promise<boolean> {
    return (await (await this.server()).tools()).has(name);
  }

  /** The keel project of xal's folder (pickProject); undefined when keel's REST api cannot tell (keel then picks). */
  projectInfo(): Promise<Project | undefined> {
    this.project ??= this.rest.get<Project[]>("/projects").then(
      (ps) => pickProject(ps, this.deps.cwd, this.cfg.project),
      (err: unknown) => {
        this.project = undefined;
        if (this.cfg.project) return { id: this.cfg.project } as Project;
        throw err;
      },
    );
    return this.project;
  }

  async projectId(): Promise<string | undefined> {
    try {
      return (await this.projectInfo())?.id ?? this.cfg.project;
    } catch {
      return this.cfg.project;
    }
  }

  /** Reads the brief once (bootstrap). keel down: no brief, never an error, a session must start without keel. */
  async loadBrief(): Promise<void> {
    if (!this.cfg.brief) return;
    try {
      const p = await this.projectInfo();
      if (!p) return;
      const inbox = await this.rest.get<{ count: number }>("/inbox/count").then((c) => c.count ?? 0, () => 0);
      this.brief = briefText(p, this.cfg.url, inbox);
    } catch {
      this.brief = "";
    }
  }

  get live(): boolean {
    return this.watching !== undefined;
  }

  /** Starts the live notices: keel's events for this project as lines through `out.print`, until unwatch(). */
  async watch(out: Out): Promise<boolean> {
    if (this.watching) return false;
    const pid = await this.projectId();
    const stop = new AbortController();
    this.watching = stop;
    let last = "";
    const path = "/events" + (pid ? `?project=${encodeURIComponent(pid)}` : "");
    void follow(
      (signal) => this.rest.stream(path, signal),
      (m) => {
        const line = noticeFor(m.event, m.data, pid);
        if (line) out.print(line);
      },
      stop.signal,
      (state, why) => {
        if (state === last) return;
        last = state;
        out.print(state === "live" ? `keel · live · following ${pid ?? "keel"} at ${this.cfg.url}` : `keel · reconnecting${why ? ` (${why})` : ""}`);
      },
    );
    return true;
  }

  unwatch(): boolean {
    if (!this.watching) return false;
    this.watching.abort();
    this.watching = undefined;
    return true;
  }

  close(): void {
    this.unwatch();
    const mcp = this.mcp;
    this.mcp = undefined;
    void mcp?.then((c) => c.close(), () => {});
  }
}
