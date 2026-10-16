// A small MCP client over stdio for keel's own MCP server (`keel2 mcp`). The slash commands call keel's MCP tools
// and print their text unchanged, so xal shows the same words as Claude Code, Codex and OpenCode do (one source:
// engine/keel_engine/mcp_server.py), and every write is recorded by keel as "via MCP · xal".
//
// Wire: JSON-RPC 2.0, one message per line (the MCP stdio transport). The server may ask the person to confirm
// (elicitation/create, for stop, delete …): `onElicit` answers it through xal's prompt.

import { spawn } from "node:child_process";

export const PROTOCOL = "2025-06-18";

export type Json = Record<string, unknown>;

/** One way to move JSON-RPC messages: a child process in xal, a pair of functions in the tests. */
export interface Transport {
  send(message: Json): void;
  onMessage(listener: (message: Json) => void): void;
  onClose(listener: (reason: string) => void): void;
  close(): void;
}

export type Elicit = (message: string, schema: Json) => Promise<{ action: "accept" | "decline" | "cancel"; content?: Json }>;

export class McpError extends Error {}

/** A child process speaking newline-delimited JSON on stdin and stdout; stderr is kept for the error message. */
export function processTransport(command: string[], env?: Record<string, string | undefined>): Transport {
  const [cmd, ...args] = command;
  if (!cmd) throw new McpError("no MCP command");
  const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
  let buffer = "";
  let stderr = "";
  const messageListeners: ((m: Json) => void)[] = [];
  const closeListeners: ((r: string) => void)[] = [];
  let closed = false;
  const finish = (reason: string) => {
    if (closed) return;
    closed = true;
    for (const l of closeListeners) l(reason);
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as Json;
        for (const l of messageListeners) l(msg);
      } catch {
        // a stray print on stdout is not a message
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  child.on("error", (err) => finish(`${command.join(" ")}: ${err.message}`));
  child.on("exit", (code, signal) => {
    const last = stderr.trim().split("\n").slice(-3).join(" ").trim();
    finish(`${command.join(" ")} exited (${signal ?? code})${last ? ": " + last : ""}`);
  });
  return {
    send(message) {
      if (!closed) child.stdin.write(JSON.stringify(message) + "\n");
    },
    onMessage(l) {
      messageListeners.push(l);
    },
    onClose(l) {
      closeListeners.push(l);
    },
    close() {
      if (closed) return;
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGTERM"), 1500);
      timer.unref?.();
      child.once("exit", () => clearTimeout(timer));
    },
  };
}

type Pending = { resolve(v: Json): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> };

export class McpClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closedWith: string | undefined;
  private toolNames: Set<string> | undefined;
  serverName = "";
  serverVersion = "";
  instructions = "";

  private readonly transport: Transport;
  private readonly clientInfo: { name: string; version: string };
  private readonly timeoutMs: number;
  onElicit: Elicit | undefined;

  constructor(transport: Transport, clientInfo: { name: string; version: string }, timeoutMs = 60_000, onElicit?: Elicit) {
    this.transport = transport;
    this.clientInfo = clientInfo;
    this.timeoutMs = timeoutMs;
    this.onElicit = onElicit;
    transport.onMessage((m) => this.receive(m));
    transport.onClose((reason) => {
      this.closedWith = reason;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new McpError(`keel's MCP server stopped: ${reason}`));
      }
      this.pending.clear();
    });
  }

  async start(): Promise<void> {
    const res = await this.request("initialize", {
      protocolVersion: PROTOCOL,
      capabilities: { elicitation: {} },
      clientInfo: this.clientInfo,
    });
    const info = (res.serverInfo ?? {}) as Json;
    this.serverName = String(info.name ?? "");
    this.serverVersion = String(info.version ?? "");
    this.instructions = String(res.instructions ?? "");
    this.transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  /** The tool names this server offers at its level (a tool above the level is not registered at all). */
  async tools(): Promise<Set<string>> {
    if (this.toolNames) return this.toolNames;
    const names = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await this.request("tools/list", cursor ? { cursor } : {});
      for (const t of (res.tools as Json[] | undefined) ?? []) names.add(String(t.name));
      cursor = typeof res.nextCursor === "string" && res.nextCursor ? res.nextCursor : undefined;
      if (!cursor) break;
    }
    this.toolNames = names;
    return names;
  }

  /** Calls a tool and returns its text; a tool error (isError) throws with the tool's own words. */
  async call(name: string, args: Json = {}): Promise<string> {
    const clean = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined && v !== null && v !== ""));
    const res = await this.request("tools/call", { name, arguments: clean });
    const text = ((res.content as Json[] | undefined) ?? [])
      .map((c) => (c.type === "text" ? String(c.text ?? "") : `[${String(c.type)}]`))
      .join("\n")
      .trimEnd();
    if (res.isError) throw new McpError(text || `${name} failed`);
    return text;
  }

  close(): void {
    this.transport.close();
  }

  private request(method: string, params: Json): Promise<Json> {
    if (this.closedWith) return Promise.reject(new McpError(`keel's MCP server stopped: ${this.closedWith}`));
    const id = this.nextId++;
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(`keel's MCP server did not answer ${method} in ${Math.round(this.timeoutMs / 1000)} s`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.transport.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private receive(m: Json): void {
    // an answer to one of our requests
    if (typeof m.id === "number" && !("method" in m)) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      const err = m.error as Json | undefined;
      if (err) p.reject(new McpError(String(err.message ?? "MCP error")));
      else p.resolve((m.result as Json) ?? {});
      return;
    }
    // a request from the server
    if (typeof m.method === "string" && m.id !== undefined) void this.answer(m.id, m.method, (m.params as Json) ?? {});
    // notifications (logging, progress, list changes) need no answer
    if (m.method === "notifications/tools/list_changed") this.toolNames = undefined;
  }

  private async answer(id: unknown, method: string, params: Json): Promise<void> {
    const reply = (body: Json) => this.transport.send({ jsonrpc: "2.0", id, ...body });
    if (method === "ping") return reply({ result: {} });
    if (method === "elicitation/create") {
      if (!this.onElicit) return reply({ result: { action: "decline" } });
      try {
        const res = await this.onElicit(String(params.message ?? "keel asks"), (params.requestedSchema as Json) ?? {});
        return reply({ result: res });
      } catch {
        return reply({ result: { action: "cancel" } });
      }
    }
    reply({ error: { code: -32601, message: `xal's keel plugin does not handle ${method}` } });
  }
}
