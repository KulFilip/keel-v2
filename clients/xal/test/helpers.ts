// Test doubles: an in-memory MCP server, a fetch that answers from a table, an Out that records.

import type { Json, Transport } from "../src/mcp.ts";
import type { Out } from "../src/keel.ts";

export type ToolHandler = (args: Json, server: FakeServer) => Promise<Json> | Json;

/** An MCP server in memory: answers initialize, tools/list and tools/call; can ask the client (elicitation). */
export class FakeServer {
  tools: Record<string, ToolHandler> = {};
  received: Json[] = [];
  initialized = false;
  private toClient: ((m: Json) => void)[] = [];
  private closeListeners: ((r: string) => void)[] = [];
  private waiting = new Map<number, (m: Json) => void>();
  private nextId = 1000;
  pageSize = 100;

  transport(): Transport {
    return {
      send: (m) => void this.receive(m),
      onMessage: (l) => void this.toClient.push(l),
      onClose: (l) => void this.closeListeners.push(l),
      close: () => this.die("closed"),
    };
  }

  die(reason: string): void {
    for (const l of this.closeListeners) l(reason);
  }

  /** The server asks the client something and waits for the answer. */
  ask(method: string, params: Json): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.emit({ jsonrpc: "2.0", id, method, params });
    });
  }

  emit(m: Json): void {
    queueMicrotask(() => {
      for (const l of this.toClient) l(m);
    });
  }

  private async receive(m: Json): Promise<void> {
    this.received.push(m);
    if (typeof m.id === "number" && this.waiting.has(m.id) && !("method" in m)) {
      this.waiting.get(m.id)!(m);
      this.waiting.delete(m.id);
      return;
    }
    const reply = (body: Json) => this.emit({ jsonrpc: "2.0", id: m.id, ...body });
    switch (m.method) {
      case "initialize":
        return reply({ result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "keel", version: "0.17.3" } } });
      case "notifications/initialized":
        this.initialized = true;
        return;
      case "tools/list": {
        const names = Object.keys(this.tools);
        const start = Number(((m.params as Json) ?? {}).cursor ?? 0);
        const page = names.slice(start, start + this.pageSize);
        const next = start + this.pageSize < names.length ? String(start + this.pageSize) : undefined;
        return reply({ result: { tools: page.map((name) => ({ name, inputSchema: { type: "object" } })), ...(next ? { nextCursor: next } : {}) } });
      }
      case "tools/call": {
        const p = (m.params as Json) ?? {};
        const h = this.tools[String(p.name)];
        if (!h) return reply({ error: { code: -32602, message: `Unknown tool: ${String(p.name)}` } });
        return reply({ result: await h((p.arguments as Json) ?? {}, this) });
      }
      default:
        if (m.id !== undefined) reply({ error: { code: -32601, message: "no" } });
    }
  }
}

export const text = (t: string, isError = false): Json => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

export type Route = { status?: number; json?: unknown; body?: string; type?: string };

/** fetch over a table "METHOD /api/path" → answer; records every request. */
export function fakeFetch(routes: Record<string, Route | ((init: RequestInit | undefined) => Route)>) {
  const calls: { method: string; url: string; headers: Record<string, string>; body?: unknown }[] = [];
  const f = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const path = new URL(url).pathname + new URL(url).search;
    calls.push({ method, url, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const r = routes[`${method} ${path}`] ?? routes[`${method} ${new URL(url).pathname}`];
    if (!r) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
    const a = typeof r === "function" ? r(init) : r;
    const body = a.body ?? JSON.stringify(a.json ?? {});
    return new Response(body, { status: a.status ?? 200, headers: { "content-type": a.type ?? "application/json" } });
  };
  return { fetch: f, calls };
}

export function recorder(answers: string[] = []): Out & { lines: string[]; asked: string[]; busy: (l?: string) => void; labels: (string | undefined)[] } {
  const lines: string[] = [];
  const asked: string[] = [];
  const labels: (string | undefined)[] = [];
  return {
    lines,
    asked,
    labels,
    print: (t) => void lines.push(t),
    busy: (l) => void labels.push(l),
    ask: async (q) => {
      asked.push(q);
      return answers.shift();
    },
  };
}

export const PROJECTS = [
  { id: "shop", name: "shop", root: "/workspace", branch: "main", flow: "change", phase: "red", acs: [1, 3], waiting: 1, running: 2 },
  { id: "api", name: "api", root: "/Users/me/src/api", branch: "dev", flow: null, phase: "", acs: [0, 0], waiting: 0, running: 0 },
];
