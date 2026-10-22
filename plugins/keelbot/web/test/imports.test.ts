// KeelBot's web part imports only react, @keel/web-sdk and its own files (keel's page shares the first two at
// run time), and every name it takes from @keel/web-sdk is in it. Like the other plugins' own check.

import { join } from "node:path";
import { checkPluginImports } from "../../../../web/src/test/pluginImports";

checkPluginImports(
  join(__dirname, ".."),
  "KeelBot",
  [
    "ASK_ASSISTANT_EVENT",
    "definePlugin",
    "SLOTS",
    "useSlot",
    "get",
    "post",
    "patch",
    "del",
    "Markdown",
    "ModelPicker",
    "StepView",
    "mergeSteps",
    "rankFiles",
    "DiffView",
    // 0.15.2: the model button's company mark, the chat list as a column, its own sound, the guide's key
    "ProviderIcon",
    "useWide",
    "playKeelBot",
    "keyLabel",
  ],
);
