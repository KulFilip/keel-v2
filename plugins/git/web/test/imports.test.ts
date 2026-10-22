// The Git plugin's web part imports only react, @keel/web-sdk and its own files (keel's page shares the first two at
// run time), and every name it takes from @keel/web-sdk is in it. Like the CI/CD plugin's own check.

import { join } from "node:path";
import { checkPluginImports } from "../../../../web/src/test/pluginImports";

checkPluginImports(
  join(__dirname, ".."),
  "Git",
  ["askAssistant", "SLOTS", "definePlugin", "get", "post", "Markdown"],
);
