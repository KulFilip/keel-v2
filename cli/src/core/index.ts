// keel TUI's core, without any UI: what a terminal front end needs to be keel. keel TUI's Ink app (src/ui) uses it;
// another front end (an xal plugin, OpenTUI) can import it unchanged.
//
//   const core = new KeelCore({ url: "http://localhost:8080" }); await core.start();
//   core.on("notice", (text) => …); core.on("answer", (a) => …); core.on("change", (snapshot) => …);
//   const reply = await run({ core, width: 100 }, "/status");      // blocks of text, maybe a pick or an ask
//   if (reply.chat) await core.send(reply.chat);                     // plain text asks KeelBot

export { KeelCore, type Snapshot, type ChatState, type CoreOptions, type CoreEvents } from "./keel";
export { TABLE, type CommandSpec } from "./commands";
export { COMMANDS, COMMANDS_BY_NAME, complete, draw, follow, helpText, parse, run, dashboardUrl, type Block, type BlockKind, type Choice,
  type Command, type Completion, type Ctx, type PanelName, type Parsed, type Pick, type Ask, type Reply } from "./commands";
export * as format from "./format";
export { renderMarkdown, fileLines, plain, FILE_LINE, type Style } from "./markdown";
export { makeTheme, makePaint, applyLevel, colorLevel, themeName, contrast, DARK, LIGHT, PLAIN, type Paint, type Palette, type Theme, type Role } from "./theme";
export { highlight, language } from "./highlight";
export { colorDiagram } from "./colorize";
export { notice } from "./notices";
export { SseParser, subscribe, type LiveState, type SseMessage } from "./sse";
export { connect, normalizeUrl, setCommand, viaHeaders } from "./transport";
export { LOGO } from "./logo";
export { VERSION } from "./version";
