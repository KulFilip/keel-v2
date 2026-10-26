// keel 0.18.57 Settings › Plugins: what this keel has installed (the rows as before), the marketplace and the sources
// and rules (pages/plugins/PluginsPage.tsx). #/settings/plugins/<name> is one plugin's own page, and the marketplace's
// workflows, rule packs, skills and stacks (#/settings/plugins/workflow/<name>, …) open there too.

import { PluginsPage } from "../plugins/PluginsPage";

export function PluginsTab({ rest }: { rest?: string }) {
  return <PluginsPage pid="" rest={rest} />;
}
