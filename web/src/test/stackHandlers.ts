// keel 0.18.9 Stacks: MSW handlers in the api's shapes. The project's stacks (suggest, check that saves nothing, save,
// remove, turn off, one with its YAML) work on the `stacks` list the Stacks page reads; the marketplace's Stacks
// (search with keel's own as builtin, one stack with its verified YAML and keel's check, install with replace). They
// come before the plugin marketplace's handlers (/api/marketplace/:name would take "stacks") and before
// /api/projects/:pid/stacks/:name routes that would take "suggest".

import { http, HttpResponse } from "msw";
import type { Stack } from "../api";
import type { BuiltinStack, MarketStack, StackHit, StackReview } from "../stackMarketApi";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export const ZIG_YAML = "name: zig\nlane: api\ndetect:\n  files: [build.zig]\nlayers:\n  - {id: unit, what: pure functions}\ncommands:\n  api_test_module: zig build test\n";
const review: StackReview = { lane: "api", detect: { files: ["build.zig"] }, layers: ["unit"], commands: { api_test_module: "zig build test" },
  tools: [{ name: "zig-fmt", run: "zig fmt {FILES}", on: "edit", fail: "fix" }], skills: [] };

type Entry = Omit<MarketStack, "installed" | "update" | "conflict">;

export function createStackDb() {
  const zig: Entry = {
    name: "zig", kind: "stacks", title: "Zig", publisher: "keel", publisher_title: "keel", verified: true, version: "1.1.0",
    summary: "Zig with zig build.", category: "other", review, fits: true, refused: null, source: "keel", latest: "1.1.0", trust: "content",
    builtin: false, yaml: ZIG_YAML, versions: [{ version: "1.1.0" }, { version: "1.0.0" }], checks: ["the file's signature matches a key of its publisher"],
    catalog_review: review, fetch_error: null,
    check: { ok: true, errors: [], warnings: ["there is no api_test_ac"], name: "zig", lane: "api", review, detects_here: false, replaces: null, yaml: ZIG_YAML },
  };
  return {
    catalog: [zig],
    builtin: [{ name: "go", lane: "api", source: "keel", detect: { files: ["go.mod"] }, installable: false, builtin: true, publisher: "keel",
      trust: "content", used: false, off: false, installed: false }] as BuiltinStack[],
    /** name → a marketplace install here: {version, edited} */
    installed: {} as Record<string, { version: string; edited: boolean }>,
    yaml: {} as Record<string, string>,
    /** keel 0.18.28 the project's stack languages (GET /api/projects/:pid/languages) */
    languages: [] as { name: string; ext: string[]; stacks?: string[] }[],
  };
}
export type StackDb = ReturnType<typeof createStackDb>;

const newer = (a: string, b: string) => {
  const n = (v: string) => v.split(".").map(Number);
  const [x, y] = [n(a), n(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

function decorate(m: StackDb, e: Entry): StackHit & Entry {
  const have = m.installed[e.name];
  const installed = have ? { ...have, origin: "marketplace" } : null;
  return { ...clone(e), installed, update: have && e.version && newer(e.version, have.version) ? e.version : null, conflict: null } as StackHit & Entry;
}

export function stackHandlers(m: StackDb, db: { stacks: Stack[] }, log: (req: Request) => Promise<Record<string, unknown>>) {
  const own = (name: string, yaml: string, origin = "project", market: Stack["market"] = null): Stack => ({
    name, lane: /lane: web/.test(yaml) ? "web" : "api", source: "project", origin, detected: true, detect: "build.zig", layers: ["unit"],
    commands: [{ name: "api_test_module", cmd: "zig build test" }], tools: [], skills: [], removable: true, off: false, why: null, market,
    file: `.keel/stacks/${name}.yml`,
  });
  return [
    http.get("/api/projects/:pid/languages", () => HttpResponse.json({ languages: m.languages })),
    http.get("/api/projects/:pid/stacks/suggest", ({ request }) => {
      const lane = new URL(request.url).searchParams.get("lane") ?? "api";
      return HttpResponse.json({
        lane, lanes: { api: ["build.zig (Zig)"], web: [] }, name: lane === "web" ? "ludus-web" : "ludus-api", closest: null, read: ["build.zig", "Makefile (targets: test)"],
        detect: { files: ["build.zig"], extensions: [".zig"], package_deps: [] }, layers: [{ id: "unit", what: "pure rules", where: "src" }], skills: {},
        keys: [{ key: "api_test_ac", what: "test one acceptance criterion", placeholder: "{AC}" }, { key: "api_test_module", what: "run every test of the module", placeholder: "" }],
        commands: { api_test_module: [{ cmd: "zig build test", from: "build.zig" }, { cmd: "make test", from: "Makefile target test" }] },
        tools: [{ name: "pre-commit", run: "pre-commit run --files {FILES}", on: "pre-commit", fail: "block", from: ".pre-commit-config.yaml" }],
      });
    }),
    http.post("/api/projects/:pid/stacks/check", async ({ request }) => {
      const b = await log(request);
      const form = b.form as Record<string, unknown> | undefined;
      const yaml = (b.yaml as string | undefined) ?? `# Stack: ${String(form?.name)}\nname: ${String(form?.name)}\nlane: ${String(form?.lane)}\n`
        + `commands: ${JSON.stringify(form?.commands ?? {})}\ntools: ${JSON.stringify(form?.tools ?? {})}\n`;
      const name = /name: (\S+)/.exec(yaml)?.[1] ?? null;
      const ok = !!name && /^[a-z0-9-]+$/.test(name);
      return HttpResponse.json({ ok, errors: ok ? [] : [`its name ${name} is not an id`], warnings: ["there is no api_test_ac: keel cannot run one criterion's tests"],
        name, lane: "api", review, detects_here: true, replaces: null, yaml, skills_missing: [] });
    }),
    http.post("/api/projects/:pid/stacks/save", async ({ request }) => {
      const b = await log(request);
      const yaml = String(b.yaml);
      const name = /name: (\S+)/.exec(yaml)![1];
      if (db.stacks.some((x) => x.name === name && x.source === "project") && !b.replace) {
        return HttpResponse.json({ error: `keel did not save the stack: this project has a stack called ${name} already`, errors: ["already"] }, { status: 422 });
      }
      const st = own(name, yaml);
      db.stacks = [...db.stacks.filter((x) => x.name !== name), st];
      m.yaml[name] = yaml;
      return HttpResponse.json({ stack: st, path: `.keel/stacks/${name}.yml`, replaced: false, warnings: [] });
    }),
    http.put("/api/projects/:pid/stacks/:name/off", async ({ request, params }) => {
      const b = await log(request);
      db.stacks = db.stacks.map((x) => (x.name === params.name ? { ...x, off: !!b.off } : x));
      return HttpResponse.json({ name: params.name, off: !!b.off, all: db.stacks.filter((x) => x.off).map((x) => x.name) });
    }),
    http.delete("/api/projects/:pid/stacks/:name", async ({ request, params }) => {
      await log(request);
      const st = db.stacks.find((x) => x.name === params.name);
      if (!st?.removable) {
        return HttpResponse.json({ error: `${String(params.name)} ships with keel: it cannot be removed.`, hint: "Turn it off for this project instead." }, { status: 409 });
      }
      db.stacks = db.stacks.filter((x) => x.name !== params.name);
      delete m.installed[String(params.name)];
      return HttpResponse.json({ name: params.name, removed: st.file, back: null });
    }),
    http.get("/api/projects/:pid/stacks/:name", ({ params }) => {
      const st = db.stacks.find((x) => x.name === params.name);
      if (!st) return HttpResponse.json({ error: `No stack called "${String(params.name)}"` }, { status: 404 });
      return HttpResponse.json({ ...st, yaml: m.yaml[st.name] ?? `name: ${st.name}\nlane: ${st.lane}\n` });
    }),
    http.get("/api/marketplace/stacks", ({ request }) => {
      const q = (new URL(request.url).searchParams.get("q") ?? "").toLowerCase();
      const has = (xs: string[]) => !q || xs.some((s) => s.toLowerCase().includes(q));
      return HttpResponse.json({
        stacks: m.catalog.filter((e) => has([e.name, e.title, e.summary])).map((e) => {
          const { versions: _v, checks: _c, yaml: _y, catalog_review: _r, fetch_error: _f, builtin: _b, check: _k, ...hit } = decorate(m, e);
          return hit;
        }),
        builtin: m.builtin.filter((b) => has([b.name, b.lane])), sources: [{ id: "keel", title: "keel official", ok: true }],
        categories: ["jvm", "javascript", "python", "php", "go", "rust", "dotnet", "other"], catalog_error: null,
      });
    }),
    http.get("/api/marketplace/stacks/:name", ({ params }) => {
      const b = m.builtin.find((x) => x.name === params.name);
      if (b) return HttpResponse.json({ ...b, title: b.name, yaml: "name: go\nlane: api\n", review: { ...review, lane: b.lane }, verified: true,
        publisher_title: "keel", fetch_error: null, update: null, check: null, checks: ["it ships with keel's image"] });
      const e = m.catalog.find((x) => x.name === params.name);
      if (!e) return HttpResponse.json({ error: `There is no stack ${String(params.name)} in the catalogs keel reads.` }, { status: 404 });
      return HttpResponse.json(decorate(m, e));
    }),
    http.post("/api/projects/:pid/stacks/market/install", async ({ request }) => {
      const b = await log(request);
      const e = m.catalog.find((x) => x.name === b.name)!;
      const version = (b.version as string | undefined) ?? e.version ?? "";
      if (m.installed[e.name] && !b.replace) return HttpResponse.json({ error: `This project has a stack called ${e.name} already.`, hint: "replace" }, { status: 409 });
      m.installed[e.name] = { version, edited: false };
      const st = own(e.name, e.yaml ?? "", "marketplace", { catalog: "keel", version, edited: false });
      db.stacks = [...db.stacks.filter((x) => x.name !== e.name), st];
      return HttpResponse.json({ stack: st, path: `.keel/stacks/${e.name}.yml`, market: { catalog: "keel", name: e.name, version }, review, warnings: [] });
    }),
  ];
}
