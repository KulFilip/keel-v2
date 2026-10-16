// keel TUI's version: keel v2's (cli/package.json, engine/pyproject.toml and keel2 move together). The build puts
// it in from package.json; tests and tsx see the fallback.
declare const __KEEL_TUI_VERSION__: string | undefined;
export const VERSION: string = typeof __KEEL_TUI_VERSION__ === "string" ? __KEEL_TUI_VERSION__ : "0.17.3";
