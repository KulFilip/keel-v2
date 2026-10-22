// The Code Review plugin's web part imports only react, @keel/web-sdk and its own files (keel's page shares the first two
// at run time; its stylesheet is its own too), and every name it takes from @keel/web-sdk is in it. Like the Tasks
// plugin's own check.

import { join } from "node:path";
import { checkPluginImports } from "../../../../web/src/test/pluginImports";

checkPluginImports(
  join(__dirname, ".."),
  "Code Review",
  ["definePlugin", "SLOTS", "askAssistant", "parseDiff", "highlight", "FileIcon", "readKeymap", "goHash"],
);
