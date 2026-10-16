// keel v2 as an xal plugin (https://github.com/xal-sh/xal, docs/plugins.md). Install: clients/xal/README.md.
//
//   /keel:<command>      slash commands in xal's TUI (the keel TUI's names: status, next, flow, approve, diagram …)
//   xal keel <command>   the same from a shell, no TUI
//   brief                a short keel brief in each new session's system prompt (flow, phase, what waits)
//   guard (opt-in)       keel's guard before xal's write, edit and bash tools (keel 0.19's host hook)
//
// The model's own keel tools are keel's MCP server, configured in xal's pluginConfig.mcp (README), not this plugin.

import { runSpec, SPECS, specFor, helpText } from "./src/commands.ts";
import { readConfig } from "./src/config.ts";
import { guardDecision } from "./src/guard.ts";
import { Keel, type Out } from "./src/keel.ts";
import type { CommandContext, Plugin, PluginContext } from "./src/xal.ts";

export const PREFIX = "keel:";

let keel: Keel | undefined;

function tuiOut(ctx: CommandContext): Out {
  return { print: (t) => ctx.print(t), busy: (l) => ctx.busy(l), ask: (q) => ctx.ask(q) };
}

const plugin: Plugin = {
  name: "keel",

  register(ctx: PluginContext) {
    const cfg = readConfig(ctx.config, process.env);
    const k = new Keel(cfg, { cwd: process.cwd(), version: ctx.runtime.app.version });
    keel = k;

    ctx.registerCommand({
      name: "keel",
      describe: "keel v2: /keel <command> or /keel:<command> (/keel help)",
      async run(args, c) {
        const [name = "help", ...rest] = args;
        const spec = specFor(name);
        if (!spec) {
          c.print(`keel: no command "${name}".\n${helpText()}`);
          return;
        }
        await runSpec(spec, rest, k, tuiOut(c));
      },
    });
    for (const spec of SPECS) {
      ctx.registerCommand({
        name: PREFIX + spec.name,
        aliases: spec.aliases?.map((a) => PREFIX + a),
        describe: `keel: ${spec.describe}${spec.usage ? ` · ${spec.usage}` : ""}`,
        run: (args, c) => runSpec(spec, args, k, tuiOut(c)).then(() => undefined),
      });
    }

    ctx.registerCli({
      name: "keel",
      describe: "keel v2 from the shell: xal keel help",
      usage: "xal keel <command> [args]",
      async run(args, c) {
        const [name = "help", ...rest] = args;
        const spec = specFor(name);
        if (!spec) {
          c.error(`keel: no command "${name}"`);
          c.print(helpText());
          process.exitCode = 1;
          return;
        }
        const out: Out = { print: (t) => c.print(t), ask: (q) => c.ask(q) };
        // `xal keel watch [--seconds N]`: follow keel's events, then stop (Ctrl+C stops it too)
        if (spec.name === "watch") {
          const i = rest.indexOf("--seconds");
          const seconds = i >= 0 ? Number(rest[i + 1]) : 0;
          if (!(await runSpec(spec, ["on"], k, out))) process.exitCode = 1;
          await new Promise<void>((resolve) => {
            if (seconds > 0) setTimeout(resolve, seconds * 1000);
            process.once("SIGINT", () => resolve());
          });
          k.unwatch();
          return;
        }
        if (!(await runSpec(spec, rest, k, out))) process.exitCode = 1;
      },
    });

    ctx.registerPrompt({
      id: "keel_brief",
      text: (p) => (p.kind === "primary" ? k.brief : ""),
    });

    if (cfg.guard) {
      ctx.registerHook({
        name: "keel-guard",
        beforeTool: (input, h) => guardDecision(cfg.guardCommand, input.tool, input.args, h.session.cwd, h.signal),
      });
    }
  },

  async bootstrap() {
    await keel?.loadBrief();
  },

  async shutdown() {
    keel?.close();
    keel = undefined;
  },
};

export default plugin;
