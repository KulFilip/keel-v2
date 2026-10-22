// The Code plugin's web part imports only react, react-dom, @keel/web-sdk and its own files (keel's page shares the
// first three at run time), and every name it takes from @keel/web-sdk is in it. Like the Code Review plugin's own
// check. What other parts share with it (the fuzzy file match, icons, the diff parser) is keel's, never this plugin's.

import { join } from "node:path";
import { checkPluginImports } from "../../../../web/src/test/pluginImports";

checkPluginImports(
  join(__dirname, ".."),
  "Code",
  [
    "definePlugin",
    "SLOTS",
    "useSlot",
    "rankFiles",
    "fuzzy",
    "openLauncher",
    "parseHash",
    "parseDiff",
    "FileIcon",
    "askAssistant",
    "get",
    // 0.15.3–0.15.4: a .md file rendered (copies as Markdown), Focus mode's key and event, keel's key helpers
    "MarkdownView",
    "FOCUS_EVENT",
    "FOCUS_KEYS",
    "isTyping",
    "modalOpen",
  ],
  { shared: ["react-dom"], exports: true },
);
