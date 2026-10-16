// The web's flow map and keel's ASCII renderer (engine/keel_engine/diagrams.py, a port of buildFlowMap) read the same
// fixtures: engine/tests/fixtures/flowmap/<workflow>.json, one per content/workflows/*.yaml, written by
// scripts/flowmap_fixtures.py. This test checks buildFlowMap against them; engine/tests/test_diagrams.py checks the
// Python port. A difference in either means the two drew different maps.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Step } from "../api";
import { buildFlowMap, type Arm, type FlowMap, type Node, type Section } from "../components/flowmap";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../engine/tests/fixtures/flowmap");

type Fixture = { workflow: string; steps: Step[]; expect: unknown };

function summary(m: FlowMap) {
  const node = (nd: Node): unknown => {
    if (nd.t === "step") return { step: nd.row.step.id, side: nd.row.side.map((r) => r.step.id) };
    if (nd.t === "if") {
      const arm = (a: Arm) => (a.t === "nodes" ? { nodes: a.nodes.map(node), side: a.side } : a.t === "jump" ? { jump: a.exit.to } : "go");
      return { if: nd.row.step.id, cond: nd.cond, side: nd.row.side.map((r) => r.step.id), yes: arm(nd.yes), no: arm(nd.no) };
    }
    if (nd.t === "loop") return { loop: nd.loop.id, body: nd.body.map(node) };
    return { include: nd.path, count: nd.count, body: nd.body.map(sec) };
  };
  const sec = (s: Section) => ({ kind: s.kind, phase: s.phase, nodes: s.nodes.map(node) });
  const parent = Object.fromEntries([...m.parentOf.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { main: m.main, sections: m.sections.map(sec), orphans: m.orphans.map((r) => r.step.id), parent_of: parent };
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();

describe("flow map fixtures shared with the ASCII renderer", () => {
  it("has one fixture per keel workflow", () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });
  for (const f of files) {
    it(`draws ${f} like the engine's port`, () => {
      const fx = JSON.parse(readFileSync(join(DIR, f), "utf8")) as Fixture;
      const steps = fx.steps.map((s) => ({ ...s, name: s.name || s.id }));
      expect(summary(buildFlowMap(steps))).toEqual(fx.expect);
    });
  }
});
