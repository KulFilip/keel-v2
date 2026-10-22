// The check every plugin's web part runs on itself (plugins/<name>/web/test/imports.test.ts): it imports only react,
// @keel/web-sdk (and what else keel's page shares with it at run time) and its own files, and every name it takes from
// @keel/web-sdk is in it. Like keel Product's own check. It reads only the plugin's top-level web folder (its own
// source files, not its tests or sub-folders): what the bundle is built from.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as sdk from "@keel/web-sdk";

/** Every `import … from "x"` and `import "x"` in a source (with `export … from "x"` too when `exports` is set): x, and
 *  the value names it takes (not the `type` ones). */
function importsOf(text: string, exports: boolean) {
  const keyword = exports ? "(?:import|export)" : "import";
  return [
    ...text.matchAll(
      new RegExp(`\\b${keyword}\\s+(?:(type\\s+)?([^;"]*?)\\s+from\\s+)?"([^"]+)"`, "g"),
    ),
  ].map(([, onlyTypes, what = "", from]) => {
    const named = /\{([\s\S]*)\}/.exec(what)?.[1] ?? "";
    const values = onlyTypes
      ? []
      : named
          .split(",")
          .map((n) => n.trim())
          .filter((n) => n && !n.startsWith("type "))
          .map((n) => n.split(/\s+as\s+/)[0]);
    return { from, values };
  });
}

/**
 * @param dir     the plugin's web folder (`join(__dirname, "..")` in its test)
 * @param label   how the suite names the plugin: "the <label> plugin's web part"
 * @param mustUse names the plugin must import from @keel/web-sdk (a subset check)
 * @param options `shared`: the packages besides react and @keel/web-sdk that keel's page shares; `exports`: also scan
 *                `export … from` (and word the check as "takes" instead of "imports")
 */
export function checkPluginImports(
  dir: string,
  label: string,
  mustUse: string[],
  options: { shared?: string[]; exports?: boolean } = {},
) {
  const exports = options.exports ?? false;
  const shared = ["react", ...(options.shared ?? []), "@keel/web-sdk"];
  const sources = () =>
    readdirSync(dir)
      .filter((f) => /\.tsx?$/.test(f))
      .map((f) => ({ file: f, text: readFileSync(join(dir, f), "utf8") }));

  describe(`the ${label} plugin's web part`, () => {
    it(`imports only ${shared.join(", ")} and its own files`, () => {
      const outside = sources().flatMap(({ file, text }) =>
        importsOf(text, exports)
          .filter(({ from }) => !from.startsWith("./") && !shared.includes(from))
          .map(({ from }) => `${file}: ${from}`),
      );
      expect(outside).toEqual([]);
    });

    it(`finds every name it ${exports ? "takes" : "imports"} from @keel/web-sdk in it`, () => {
      const used = sources().flatMap(({ text }) =>
        importsOf(text, exports)
          .filter((i) => i.from === "@keel/web-sdk")
          .flatMap((i) => i.values),
      );
      expect(used).toEqual(expect.arrayContaining(mustUse));
      expect(used.filter((name) => !(name in sdk))).toEqual([]);
    });
  });
}
