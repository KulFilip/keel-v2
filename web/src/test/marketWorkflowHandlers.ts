// 0.16.1 plugin track: MSW handlers for the marketplace for workflows (docs/plugins/21-workflow-marketplace.md §3),
// in the api shapes the engine and api build: search (GET /api/marketplace/workflows), one workflow
// (GET /api/marketplace/workflows/{name}, 409 when keel refuses it), install and update into a project, remove
// (DELETE /api/workflows/{wid}) and the publish package (GET /api/workflows/{wid}/publish). A small catalog, reset
// per test. They come before the plugin marketplace's handlers: /api/marketplace/:name would take "workflows".

import { http, HttpResponse } from "msw";
import type { Step, Workflow } from "../api";
import type {
  MarketWorkflow,
  WorkflowHit,
  WorkflowReview,
} from "../workflowMarketApi";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

const RELEASE_STEPS: Step[] = [
  { id: "collect", kind: "code", name: "collect commits", action: "run: git log --oneline v1.1.0..HEAD" },
  { id: "draft", kind: "agent", name: "draft notes", agent: "release-writer" },
  { id: "ok", kind: "gate", name: "notes approval", back: "draft", lock: true },
  { id: "edit", kind: "agent", name: "edit CHANGELOG", agent: "release-writer" },
  { id: "review", kind: "agent", name: "review", agent: "reviewer" },
  { id: "final", kind: "gate", name: "final review", lock: true },
];

const releaseReview: WorkflowReview = {
  steps: 6,
  gates: 2,
  agents: ["release-writer", "reviewer"],
  mcp: [],
  commands: ["git log --oneline v1.1.0..HEAD"],
  edits_files: true,
  keel_rules: true,
};

type Entry = MarketWorkflow;

function catalog(): Entry[] {
  return [
    {
      name: "release-notes",
      kind: "workflow",
      title: "Release notes",
      publisher: "ana-k",
      publisher_title: "ana-k",
      verified: false,
      version: "1.2.0",
      summary: "Writes release notes from the commits since the last tag, and asks you before it changes CHANGELOG.md.",
      category: "docs",
      tags: ["release"],
      review: releaseReview,
      needs: { plugins: { git: ">=1.0.0" }, agents: ["release-writer"] },
      fits: true,
      refused: null,
      source: "keel",
      installed: null,
      update: null,
      versions: [
        { version: "1.2.0", released: "2026-10-15", requires: { keel: ">=0.16.1", plugins: { git: ">=1.0.0" }, agents: ["release-writer"] },
          review: releaseReview, url: "https://github.com/ana-k/keel-workflows/releases/download/release-notes-v1.2.0/release-notes-1.2.0.yaml",
          size: 4210, sha256: "9c41e07a" },
        { version: "1.1.0", released: "2026-09-30", requires: { keel: ">=0.16.1" },
          review: { ...releaseReview, steps: 5, gates: 1, commands: [] }, size: 3900, sha256: "77aa01bc" },
      ],
      checks: [
        "Checksum sha256:9c41…e07a matches the catalog",
        "Signed by ana-k, a key the catalog lists",
        "The YAML is a valid workflow; the review keel computes matches the catalog's",
      ],
      yaml: "name: Release notes\nkeel_rules: true\nsteps:\n  - id: collect\n    kind: code\n    action: \"run: git log --oneline v1.1.0..HEAD\"\n  - id: draft\n    kind: agent\n    agent: release-writer\n",
      steps: RELEASE_STEPS,
    },
    {
      name: "hotfix",
      kind: "workflow",
      title: "Hotfix",
      publisher: "keel",
      publisher_title: "keel",
      verified: true,
      version: "1.0.0",
      summary: "A short fix: reproduce, fix, one gate.",
      category: "code",
      tags: ["fix"],
      review: { steps: 4, gates: 1, agents: ["reproducer", "implementer"], mcp: ["github"], commands: [], edits_files: true, keel_rules: true },
      needs: { plugins: {}, agents: [] },
      fits: true,
      refused: null,
      source: "keel",
      installed: null,
      update: null,
      versions: [{ version: "1.0.0", released: "2026-10-10", requires: { keel: ">=0.16.1" } }],
      checks: ["Signed by keel"],
      yaml: "name: Hotfix\n",
      steps: [
        { id: "h1", kind: "agent", name: "reproduce", agent: "reproducer" },
        { id: "h2", kind: "agent", name: "fix", agent: "implementer" },
        { id: "h3", kind: "code", name: "verify", action: "verify_green" },
        { id: "h4", kind: "gate", name: "ship?", lock: true },
      ],
    },
    {
      name: "pr-tidy",
      kind: "workflow",
      title: "PR tidy",
      publisher: "bo",
      publisher_title: "bo",
      verified: false,
      version: "1.1.0",
      summary: "Cleans up a pull request before review.",
      category: "review",
      review: { steps: 3, gates: 1, agents: ["reviewer"], mcp: [], commands: [], edits_files: false, keel_rules: false },
      needs: { plugins: {}, agents: [] },
      fits: true,
      refused: null,
      source: "keel",
      installed: { version: "1.0.0", scope: "project", wid: "pr-tidy" },
      update: "1.1.0",
      versions: [{ version: "1.1.0" }, { version: "1.0.0" }],
      checks: [],
      yaml: "name: PR tidy\n",
      steps: [],
    },
  ];
}

export function createMarketWorkflows() {
  return {
    catalog: catalog(),
    sources: [{ id: "keel", title: "keel official", ok: true }] as { id: string; title?: string; ok?: boolean; problem?: string | null }[],
    /** the api answers 404 (an older api, no workflow catalog) */
    down: false,
    /** POST install answers 409 with these */
    refuse: null as null | { error: string; missing_plugins?: string[]; missing_agents?: string[] },
    searches: [] as { q: string; category: string; project: string }[],
  };
}
export type MarketWorkflows = ReturnType<typeof createMarketWorkflows>;

/** A workflow of Build › Workflows that came from the marketplace (an update is ready). */
export const fromMarket = (version = "1.0.0", update: string | null = "1.1.0"): Workflow => ({
  id: "pr-tidy",
  name: "PR tidy",
  source: "marketplace",
  based_on: "marketplace/pr-tidy",
  keel_rules: false,
  version: 1,
  yaml: "name: PR tidy\n",
  steps: [
    { id: "p1", kind: "agent", name: "tidy", agent: "reviewer" },
    { id: "p2", kind: "gate", name: "ok?" },
  ],
  market: { catalog: "keel", name: "pr-tidy", version, update },
});

const hitOf = (e: Entry): WorkflowHit => {
  const { versions: _v, checks: _c, yaml: _y, steps: _s, ...hit } = e;
  return clone(hit);
};

export function marketWorkflowHandlers(
  m: MarketWorkflows,
  db: { workflows: Workflow[] },
  log: (req: Request) => Promise<Record<string, unknown>>,
) {
  return [
    http.get("/api/marketplace/workflows", ({ request }) => {
      if (m.down) return HttpResponse.json({ error: "Not found" }, { status: 404 });
      const u = new URL(request.url);
      const q = (u.searchParams.get("q") ?? "").toLowerCase();
      const category = u.searchParams.get("category") ?? "";
      m.searches.push({ q, category, project: u.searchParams.get("project") ?? "" });
      const hits = m.catalog
        .filter((e) => (!category || e.category === category) &&
          (!q || [e.name, e.title, e.summary, ...(e.tags ?? [])].some((s) => s.toLowerCase().includes(q))))
        .map(hitOf);
      return HttpResponse.json({
        workflows: hits,
        sources: m.sources,
        categories: [...new Set(m.catalog.map((e) => e.category))],
      });
    }),
    http.get("/api/marketplace/workflows/:name", ({ params }) => {
      const e = m.catalog.find((x) => x.name === params.name);
      if (!e) return HttpResponse.json({ error: `No workflow ${String(params.name)} in the catalogs.` }, { status: 404 });
      if (e.refused) return HttpResponse.json({ error: e.refused }, { status: 409 });
      return HttpResponse.json({ ...clone(e), review: { ...clone(e.review), warnings: e.review.commands.length ? ["It runs shell commands."] : [] } });
    }),
    http.post("/api/projects/:pid/workflows/market/install", async ({ request }) => {
      const b = await log(request);
      if (m.refuse) return HttpResponse.json(m.refuse, { status: 409 });
      const e = m.catalog.find((x) => x.name === b.name)!;
      const version = (b.version as string | undefined) ?? e.version;
      const w: Workflow = {
        id: e.name, name: e.title, source: "marketplace", based_on: `marketplace/${e.name}`, keel_rules: e.review.keel_rules,
        version: 1, yaml: e.yaml, steps: clone(e.steps), market: { catalog: e.source, name: e.name, version, update: null },
      };
      db.workflows.push(w);
      e.installed = { version, scope: b.scope as "project" | "all", wid: w.id };
      return HttpResponse.json({ workflow: w, review: e.review });
    }),
    http.post("/api/projects/:pid/workflows/market/:wid/update", async ({ request, params }) => {
      const b = await log(request);
      const old = db.workflows.find((x) => x.id === params.wid)!;
      const to = (b.version as string | undefined) ?? old.market?.update ?? old.market?.version ?? "";
      const next: Workflow = { ...old, version: old.version + 1, market: { ...old.market!, version: to, update: null } };
      if (b.mode === "keep") {
        // keep my copy: the person's version stays as a copy, the update takes the name
        db.workflows = [...db.workflows.map((x) => (x.id === old.id ? { ...x, id: `${old.id}-mine`, name: `${old.name} (mine)`, market: null } : x)), next];
      } else db.workflows = db.workflows.map((x) => (x.id === old.id ? next : x));
      const e = m.catalog.find((x) => x.name === old.market?.name);
      if (e?.installed) {
        e.installed = { ...e.installed, version: to };
        e.update = null;
      }
      return HttpResponse.json({ workflow: next });
    }),
    http.delete("/api/workflows/:wid", async ({ request, params }) => {
      await log(request);
      db.workflows = db.workflows.filter((x) => x.id !== params.wid);
      return new HttpResponse(null, { status: 204 });
    }),
    http.get("/api/workflows/:wid/publish", ({ params }) =>
      new HttpResponse(new Uint8Array([0x50, 0x4b, 0x05, 0x06]), {
        headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${String(params.wid)}.zip"` },
      })),
  ];
}
