// A tiny MCP stdio server for the transport test: one tool, newline-delimited JSON-RPC, a log line on stderr.
import { createInterface } from "node:readline";

process.stderr.write("fake-keel starting\n");
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake-keel", version: "1" } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "keel_status", inputSchema: { type: "object" } }] } });
  else if (m.method === "tools/call") send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `status of ${m.params.arguments.project}` }] } });
});
