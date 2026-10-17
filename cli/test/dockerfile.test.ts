// The image builds keel TUI in a stage of its own that copies only the files outside cli/ the app imports (Dockerfile,
// stage "cli"). A new import from web/ or plugins/ that is not copied there breaks the image while every test passes.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(cli, "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(n) ? [p] : [];
  });
}

function outsideImports(): string[] {
  const seen = new Set<string>(), outside = new Set<string>(), todo = sources(join(cli, "src"));
  while (todo.length) {
    const f = todo.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const m of readFileSync(f, "utf8").matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      const t = resolve(dirname(f), m[1]);
      const hit = [t, `${t}.ts`, `${t}.tsx`, join(t, "index.ts")].find((c) => existsSync(c) && statSync(c).isFile());
      if (!hit) continue;
      if (!hit.startsWith(cli + "/")) outside.add(relative(repo, hit));
      if (/\.tsx?$/.test(hit)) todo.push(hit);
    }
  }
  return [...outside].sort();
}

describe("the image's keel TUI stage", () => {
  it("copies every file outside cli/ that keel TUI imports", () => {
    const docker = readFileSync(join(repo, "Dockerfile"), "utf8");
    const stage = docker.slice(docker.indexOf("AS cli"), docker.indexOf("FROM", docker.indexOf("AS cli")));
    const copied = [...stage.matchAll(/^COPY\s+(.+)\s+\S+$/gm)].flatMap((m) => m[1].split(/\s+/));
    const imports = outsideImports();
    expect(imports).toContain("web/src/api.ts");
    expect(imports.filter((f) => !copied.some((c) => f === c || f.startsWith(c.replace(/\/?$/, "/"))))).toEqual([]);
  });
});
