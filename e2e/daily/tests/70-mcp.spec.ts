// J3 MCP: keel2 mcp over stdio answers tools/list and a read tool (keel_projects, keel_status).
import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { KEEL2, projectNamed } from "../lib/keel";

function rpc(args: string[]): Promise<{ list: any; projects: any; status: any }> {
  return new Promise((resolve, reject) => {
    const p = spawn(KEEL2, ["mcp", ...args], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let buf = "";
    const got: Record<number, any> = {};
    const timer = setTimeout(() => { p.kill(); reject(new Error("keel2 mcp timed out; got " + JSON.stringify(Object.keys(got)) + " " + buf.slice(-300))); }, 60_000);
    p.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("{")) continue;
        const m = JSON.parse(line);
        if (m.id) got[m.id] = m;
        if (got[2] && got[3] && got[4]) { clearTimeout(timer); p.kill(); resolve({ list: got[2], projects: got[3], status: got[4] }); }
      }
    });
    const send = (o: object) => p.stdin.write(JSON.stringify(o) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "0" } } });
    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "keel_projects", arguments: {} } });
      send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "keel_status", arguments: {} } });
    }, 1500);
  });
}

test.describe("J3 MCP", () => {
  test("J3 keel2 mcp lists tools and answers keel_projects and keel_status", async () => {
    await projectNamed("shop");
    const r = await rpc([]);
    const names: string[] = r.list.result.tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(["keel_projects", "keel_status", "keel_flows"]));
    expect(names.filter((n) => /approve|start_flow|git_push|db_change/.test(n)), "read-only by default: no write tool").toEqual([]);
    expect(JSON.stringify(r.projects.result)).toContain("shop");
    expect(r.status.result.isError ?? false).toBeFalsy();
  });
});
