// Builds keel TUI into one file, dist/keel-tui.mjs, that needs only Node 20+: the app, Ink, React and keel's own typed
// client (web/src/api.ts, web/src/inboxApi.ts, web/src/rulesApi.ts, web/src/signIn.ts, plugins/keelbot/web/keelbotApi.ts) all
// inside.
import { build } from "esbuild";
import { readFileSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
const out = join(here, "dist/keel-tui.mjs");

await build({
  entryPoints: [join(here, "src/main.tsx")],
  outfile: out,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  jsx: "automatic",
  minify: false,
  legalComments: "none",
  alias: { "@keel/web-sdk": join(here, "src/core/sdk.ts") },
  // React DevTools: Ink loads it only with DEV=true; keel TUI never does, so an empty stand-in keeps it out
  plugins: [{
    name: "no-devtools",
    setup(b) {
      b.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: "react-devtools-core", namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export default { initialize() {}, connectToDevTools() {} };", loader: "js" }));
    },
  }],
  define: { __KEEL_TUI_VERSION__: JSON.stringify(pkg.version), "process.env.NODE_ENV": '"production"' },
  // Ink's dependencies are CommonJS in places: give them require() inside the ES module
  banner: { js: "import { createRequire as __keelRequire } from 'node:module'; const require = __keelRequire(import.meta.url);" },
  logLevel: "warning",
});
chmodSync(out, 0o755);
console.log(out);
