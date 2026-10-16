// Skills in the marketplace (keel 0.18.6): MSW handlers in the api's shapes: search (GET /api/marketplace/skills: the
// catalogs' skills with what the project has, and keel's own as builtin), one skill (GET /api/marketplace/skills/{name}:
// the verified text and keel's review, or keel's own), install (POST /api/projects/{pid}/skills/market/install, 409
// without replace), the agents a skill is on (PUT /api/projects/{pid}/skills/{sid}) and remove (DELETE). They come
// before the plugin marketplace's handlers: /api/marketplace/:name would take "skills".

import { http, HttpResponse } from "msw";
import type { BuiltinSkill, MarketSkill, SkillHit, SkillReview } from "../skillMarketApi";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export const CHANGELOG_TEXT = `---
name: changelog-entries
description: How to write a changelog entry.
---
# Changelog entries

## When
At the end of a feature.

## How
One line per change.
`;

const review: SkillReview = { tokens: 31, sections: ["When", "How"], description: "How to write a changelog entry." };

type Entry = Omit<MarketSkill, "installed" | "update">;

function catalog(): Entry[] {
  return [
    {
      name: "changelog-entries", kind: "skills", title: "Changelog entries", publisher: "keel", publisher_title: "keel", verified: true,
      version: "1.1.0", summary: "Write the changelog entry of a feature.", category: "authoring", tags: ["docs"], review,
      fits: true, refused: null, source: "keel", latest: "1.1.0", trust: "content", builtin: false, text: CHANGELOG_TEXT,
      versions: [{ version: "1.1.0", released: "2026-10-16", review }, { version: "1.0.0", released: "2026-10-01", review }],
      checks: ["the file's signature matches a key of its publisher"], catalog_review: review, fetch_error: null,
    },
    {
      name: "flaky-tests", kind: "skills", title: "Flaky tests", publisher: "ana-k", publisher_title: "ana-k", verified: false,
      version: "0.2.0", summary: "Find why a test fails only sometimes.", category: "testing", review: { tokens: 1800, sections: ["Steps"], description: "" },
      fits: true, refused: null, source: "keel", latest: "0.2.0", trust: "content", builtin: false, text: "---\nname: flaky-tests\n---\nx\n",
      versions: [{ version: "0.2.0" }], checks: [], fetch_error: null,
    },
  ];
}

function builtin(): BuiltinSkill[] {
  return [{
    name: "debugging", title: "Debugging", summary: "Find the cause of a bug from evidence.", source: "keel", kind: "debugging",
    category: "debugging", stack: "any", version: "v2", tokens: 2300, agents: ["reproducer"], when: "bug-repro", enabled: true,
    refs: 7, builtin: true, publisher: "keel", trust: "content",
  }];
}

export function createMarketSkills() {
  return {
    catalog: catalog(),
    builtin: builtin(),
    /** name → the project's copy: {version, edited, sid, agents} */
    installed: {} as Record<string, { version: string; edited: boolean; sid: string; agents: string[] }>,
    /** no catalog answers: skills is empty and catalog_error says why */
    down: false,
    badSignature: null as string | null,
    searches: [] as { q: string; category: string; project: string }[],
  };
}
export type MarketSkills = ReturnType<typeof createMarketSkills>;

const newer = (a: string, b: string) => {
  const n = (v: string) => v.split("-")[0].split(".").map(Number);
  const [x, y] = [n(a), n(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

function decorate<T extends Entry>(m: MarketSkills, e: T): T & Pick<SkillHit, "installed" | "update"> {
  const installed = m.installed[e.name] ? clone(m.installed[e.name]) : null;
  const update = installed && e.version && newer(e.version, installed.version) ? e.version : null;
  return { ...clone(e), installed, update };
}

export function marketSkillHandlers(m: MarketSkills, log: (req: Request) => Promise<Record<string, unknown>>) {
  return [
    http.get("/api/marketplace/skills", ({ request }) => {
      const u = new URL(request.url);
      const q = (u.searchParams.get("q") ?? "").toLowerCase();
      const category = u.searchParams.get("category") ?? "";
      m.searches.push({ q, category, project: u.searchParams.get("project") ?? "" });
      const has = (xs: string[]) => !q || xs.some((s) => s.toLowerCase().includes(q));
      const skills = m.down ? [] : m.catalog.filter((e) => (!category || e.category === category) && has([e.name, e.title, e.summary]))
        .map((e) => {
          const { versions: _v, checks: _c, text: _t, catalog_review: _r, fetch_error: _f, builtin: _b, ...hit } = decorate(m, e);
          return hit;
        });
      return HttpResponse.json({
        skills, sources: m.down ? [] : [{ id: "keel", title: "keel official", ok: true }],
        categories: ["testing", "implementation", "review", "debugging", "knowledge", "authoring", "other"],
        catalog_error: m.down ? { error: "No catalog answers.", hint: "Refresh the catalogs." } : null,
        builtin: m.builtin.filter((b) => (!category || b.category === category) && has([b.name, b.summary])),
      });
    }),
    http.get("/api/marketplace/skills/:name", ({ params }) => {
      const b = m.builtin.find((x) => x.name === params.name);
      if (b) {
        return HttpResponse.json({ ...b, builtin: true, publisher_title: "keel", verified: true, text: "# Debugging\n\nFind the cause first.\n",
          review: { tokens: b.tokens, sections: ["Steps"], description: b.summary }, installed: null, update: null, fetch_error: null,
          checks: ["it ships with keel's image"], refs: [{ path: "references/bisect.md", tokens: 900 }] });
      }
      const e = m.catalog.find((x) => x.name === params.name);
      if (!e) return HttpResponse.json({ error: `There is no skill ${String(params.name)} in the catalogs keel reads.` }, { status: 404 });
      const out = decorate(m, e);
      if (m.badSignature === e.name) {
        return HttpResponse.json({ ...out, text: null, fetch_error: { error: `The signature of ${e.name} ${e.version} does not match its publisher's key.`, hint: "keel installed nothing." } });
      }
      return HttpResponse.json(out);
    }),
    http.post("/api/projects/:pid/skills/market/install", async ({ request }) => {
      const b = await log(request);
      const e = m.catalog.find((x) => x.name === b.name);
      if (!e) return HttpResponse.json({ error: `There is no skill ${String(b.name)}.` }, { status: 404 });
      const version = (b.version as string | undefined) ?? e.version ?? "";
      const have = m.installed[e.name];
      if (have && have.version === version && !b.replace) return HttpResponse.json({ error: `${e.name} ${version} is installed already.` }, { status: 409 });
      if (have && !b.replace) return HttpResponse.json({ error: `${e.name} ${have.version} is installed; installing ${version} replaces it (replace).` }, { status: 409 });
      const agents = [...new Set([...(have?.agents ?? []), ...((b.agents as string[] | undefined) ?? [])])];
      m.installed[e.name] = { version, edited: false, sid: e.name, agents };
      return HttpResponse.json({ skill: { id: e.name, kind: "authoring", source: "marketplace", stack: "any", version, tokens: e.review.tokens, agents,
        when: "on demand", enabled: true }, market: { catalog: "keel", name: e.name, version }, review: e.review });
    }),
    http.delete("/api/projects/:pid/skills/:sid", async ({ request, params }) => {
      await log(request);
      const name = Object.keys(m.installed).find((n) => m.installed[n].sid === params.sid);
      if (name) delete m.installed[name];
      return HttpResponse.json({ removed: params.sid });
    }),
    http.put("/api/projects/:pid/skills/:sid", async ({ request, params }) => {
      const b = (await log(request)) as { agents?: string[] };
      const bi = m.builtin.find((x) => x.name === params.sid);
      if (bi && b.agents) bi.agents = b.agents;
      const name = Object.keys(m.installed).find((n) => m.installed[n].sid === params.sid);
      if (name && b.agents) m.installed[name].agents = b.agents;
      return HttpResponse.json({ id: params.sid, kind: "knowledge", source: "yours", stack: "any", version: "v1", tokens: 500,
        agents: b.agents ?? [], when: "", enabled: true });
    }),
  ];
}
