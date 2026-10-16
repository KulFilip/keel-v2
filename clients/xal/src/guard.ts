// keel's guard as an xal beforeTool hook. keel's own PreToolUse hook (engine/keel_engine/hook.py) already reads
// Claude Code's input: {tool_name, tool_input, cwd} on stdin, exit 0 = allow, exit 2 = refuse with the reason on
// stderr. xal's file tools take Claude's argument names (file_path, old_string, new_string, content; bash: command),
// so the hook only renames the tools. The command is keel 0.19's host hook (`keel2 hook pre-tool`, the plan in
// docs/plans/agent-clients.md §F): it refuses only while this folder holds a keel step, and is silent otherwise.

import { spawn } from "node:child_process";
import type { BeforeToolResult } from "./xal.ts";

/** xal tool → the name keel's hook knows. MCP tools keep their name (mcp__server__tool is the same in both). */
export const TOOL_NAMES: Record<string, string> = {
  write: "Write",
  edit: "Edit",
  bash: "Bash",
  read: "Read",
  grep: "Grep",
  glob: "Glob",
};

const CHANGES = new Set(["Write", "Edit", "Bash"]);

export type Run = (command: string[], stdin: string, signal: AbortSignal) => Promise<{ code: number | null; stderr: string; error?: string }>;

export function hookInput(tool: string, args: Record<string, unknown>, cwd: string): { tool_name: string; tool_input: Record<string, unknown>; cwd: string } | undefined {
  const name = TOOL_NAMES[tool] ?? (tool.startsWith("mcp__") ? tool : undefined);
  if (!name) return undefined;
  return { tool_name: name, tool_input: args, cwd };
}

/** keel's verdict for one xal tool call. Fails closed for tools that change something when the guard cannot run. */
export async function guardDecision(
  command: string[],
  tool: string,
  args: Record<string, unknown>,
  cwd: string,
  signal: AbortSignal,
  run: Run = runHook,
): Promise<BeforeToolResult> {
  const input = hookInput(tool, args, cwd);
  if (!input) return undefined;
  const changes = CHANGES.has(input.tool_name) || (input.tool_name.startsWith("mcp__") && !input.tool_name.startsWith("mcp__keel__"));
  const res = await run(command, JSON.stringify(input), signal);
  if (res.code === 0) return undefined;
  const said = res.stderr.trim().split("\n").filter(Boolean).slice(-3).join(" ");
  if (res.code === 2) return { type: "block", reason: said || "[keel guard] the phase does not allow this" };
  if (!changes) return undefined;
  return {
    type: "block",
    reason: `[keel guard] could not ask keel (${res.error ?? `exit ${res.code}`}${said ? ": " + said : ""}), so a change is refused. ` +
      "Set pluginConfig.keel.guard to false to work without keel's guard.",
  };
}

export const runHook: Run = (command, stdin, signal) =>
  new Promise((resolve) => {
    const [cmd, ...args] = command;
    let stderr = "";
    let child;
    try {
      child = spawn(cmd!, args, { stdio: ["pipe", "ignore", "pipe"], signal });
    } catch (err) {
      resolve({ code: null, stderr: "", error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (c: string) => {
      stderr = (stderr + c).slice(-4000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stderr, error: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
    child.stdin!.on("error", () => {});
    child.stdin!.end(stdin);
  });
