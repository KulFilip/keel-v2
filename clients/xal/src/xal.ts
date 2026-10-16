// The parts of xal's plugin API this plugin uses (xal apps/cli/src/plugins/types.ts, commands/types.ts,
// cli/types.ts, hooks/types.ts, agent/prompt/registry.ts at 0.1.0-beta.256). xal loads plugins by duck typing and
// publishes no types package, so the plugin keeps its own copy of the shapes it relies on. xal is beta: when one of
// these changes, this file and test/contract.test.ts say so first.

export interface SelectOption<T> {
  label: string;
  detail: string;
  note?: string;
  active?: boolean;
  value: T;
}

/** What a slash command gets (TUI): print appends an info block to the transcript. */
export interface CommandContext {
  print(line: string): void;
  busy(label?: string): void;
  select<T>(request: { options: SelectOption<T>[]; search?: string }): Promise<T | undefined>;
  ask(question: string): Promise<string | undefined>;
}

export interface Command {
  name: string;
  aliases?: string[];
  describe: string;
  hidden?: boolean;
  run(args: string[], ctx: CommandContext): Promise<void>;
}

/** What a top-level CLI command (`xal keel …`) gets. */
export interface CliContext {
  print(line: string): void;
  error(line: string): void;
  ask(question: string): Promise<string | undefined>;
}

export interface Cli {
  name: string;
  describe: string;
  usage?: string;
  run?(args: string[], ctx: CliContext): Promise<void>;
}

export interface HookContext {
  session: { id: string; kind: string; cwd: string; mode: string };
  signal: AbortSignal;
}

export type BeforeToolResult = { type: "replace"; args: Record<string, unknown> } | { type: "block"; reason: string } | undefined;

export interface Hook {
  name: string;
  beforeTool?(input: { callId: string; tool: string; args: Record<string, unknown> }, ctx: HookContext): Promise<BeforeToolResult> | BeforeToolResult;
}

export interface PromptSection {
  id: string;
  text(ctx: { kind: string; cwd: string }): string;
}

export interface PluginContext {
  config: Record<string, unknown>;
  runtime: { app: { name: string; version: string } };
  signal: AbortSignal;
  registerCli(cli: Cli): void;
  registerCommand(command: Command): void;
  registerHook(hook: Hook): void;
  registerPrompt(section: PromptSection): void;
}

export interface Plugin {
  name: string;
  register(ctx: PluginContext): void;
  bootstrap?(ctx: PluginContext): Promise<void>;
  shutdown?(ctx: PluginContext): Promise<void>;
}
