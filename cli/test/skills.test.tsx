// keel TUI's skills (0.18.6): /skills (the list and the marketplace's), /skill <id>, /skill attach and detach (an agent's
// own skill list too), /skill install from the marketplace (its review, then one yes), /create skill (KeelBot writes it,
// keel checks it, one yes saves it and puts it on the agents its front matter names), and KeelBot's keel-skill button.

import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { App, type Probe } from "../src/ui/App";
import { KeelCore } from "../src/core/keel";
import { skillHead, skillProblems, splitButtons } from "../src/core/buttons";
import { TABLE } from "../src/core/commands";
import { makeTheme } from "../src/core/theme";
import { stripAnsi } from "../src/script";
import { stubKeel, tick, waitFor } from "./stub";

const none = makeTheme({ NO_COLOR: "1" }, 0);

function setup() {
  const stub = stubKeel();
  const core = new KeelCore({ url: "http://keel.test", fetch: stub.fetch, noLive: true, cwd: "/work/demo/src" });
  const probe: Probe = { started: false, busy: false, pick: false, ask: false, chatBusy: false, answers: 0 };
  const r = render(<App core={core} probe={probe} width={140} theme={none} />);
  const frame = () => stripAnsi(r.lastFrame() ?? "");
  const type = async (s: string) => {
    r.stdin.write(s);
    await tick(40);
  };
  const enter = async () => {
    r.stdin.write("\r");
    await tick(40);
    await waitFor(() => !probe.busy);
    await tick(40);
  };
  const run = async (s: string) => {
    await type(s);
    await enter();
  };
  return { stub, core, probe, r, frame, type, enter, run };
}

const finished = (core: KeelCore) => core.onMessage({ event: "helper.finished",
  data: JSON.stringify({ type: "helper.finished", thread_id: "s1", project_id: "demo", at: "x", data: {} }) });

const SKILL = "---\nname: changelog-entries\ndescription: How to write a changelog entry.\nagents: [investigator]\n---\n# Changelog\n\nOne line per change.";

describe("keel TUI's skills (0.18.6)", () => {
  it("the command table has /skills and /skill, and /create says skill", () => {
    const names = TABLE.commands.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["skills", "skill"]));
    expect(TABLE.commands.find((c) => c.name === "skill")!.writes).toBe(true);
    expect(TABLE.commands.find((c) => c.name === "create")!.args).toContain("skill");
  });

  it("/skills lists them with the agents that load each; /skill <id> reads one", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.run("/skills");
    expect(t.frame()).toContain("2 skills on demo");
    expect(t.frame()).toMatch(/debugging\s+debugging · keel · 2\.3k tokens · reproducer/);
    expect(t.frame()).toMatch(/mine\s+knowledge · yours · 40 tokens · no agent · off/);
    await t.run("/skill debugging");
    expect(t.frame()).toContain("loaded by reproducer · when bug-repro");
    expect(t.frame()).toContain("references/bisect.md");
    expect(t.frame()).toContain("Find the cause first.");
    t.r.unmount();
  });

  it("/skill attach and detach: the skill's agents, and an agent's own skill list too", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.run("/skill attach debugging investigator reviewer");
    expect(t.frame()).toContain("✓ put debugging on investigator, reviewer; loaded by reproducer, investigator, reviewer now");
    expect(t.stub.state.skillAgents.debugging).toEqual(["reproducer", "investigator", "reviewer"]);
    expect(t.stub.state.reviewerSkills).toEqual(["review", "debugging"]);
    await t.run("/skill detach debugging reviewer");
    expect(t.stub.state.skillAgents.debugging).toEqual(["reproducer", "investigator"]);
    expect(t.stub.state.reviewerSkills).toEqual(["review"]);
    await t.run("/skill attach debugging ghost");
    expect(t.frame()).toContain("No agent ghost here");
    t.r.unmount();
  });

  it("/skills market and /skill install: the review first, one yes installs it for the agents named", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.run("/skills market flaky");
    expect(t.stub.calls.find((c) => c.path === "/api/marketplace/skills")!.query).toBe("?q=flaky&project=demo");
    expect(t.frame()).toContain("flaky-tests  Flaky tests · keel · version 1.0.0 · 1.2k tokens");
    expect(t.frame()).toContain("keel's own (keel) · in every project");
    await t.run("/skill install flaky-tests investigator");
    expect(t.frame()).toContain("Install flaky-tests 1.0.0?");
    expect(t.frame()).toContain("loaded by investigator");
    await t.enter();
    expect(t.stub.calls.find((c) => c.path === "/api/projects/demo/skills/market/install")!.body).toEqual({ name: "flaky-tests", agents: ["investigator"] });
    expect(t.frame()).toContain("✓ installed flaky-tests 1.0.0 from the catalog keel; loaded by investigator.");
    await t.run("/skill install debugging");
    expect(t.frame()).toContain("debugging is keel's own: it is in every project already");
    t.r.unmount();
  });

  it("/create skill: KeelBot writes it, keel checks it, one yes saves it and puts it on the agents it names", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.run("/create skill how we write changelog entries --for investigator");
    const sent = t.stub.calls.find((c) => c.path.endsWith("/s1/turn"))!.body as { text: string };
    expect(sent.text).toContain("Write a new keel skill (a SKILL.md) for this project: how we write changelog entries");
    expect(sent.text).toContain("agents: [investigator]");
    expect(sent.text).toContain("keel-skill block");
    await waitFor(() => t.probe.chatBusy);
    t.stub.answer("Here it is.\n\n```keel-skill\n" + SKILL + "\n```");
    finished(t.core);
    await waitFor(() => t.probe.pick);
    await tick(80);                                                     // the picker's keys are live after its render
    expect(t.frame()).toContain("KeelBot wrote a skill: save changelog-entries?");
    expect(t.frame()).toContain("loaded by investigator");
    await t.enter();
    await waitFor(() => t.stub.calls.some((c) => c.path === "/api/projects/demo/skills/import"));
    await waitFor(() => (t.stub.state.skillAgents["changelog-entries"] ?? []).length > 0);
    expect(t.stub.state.skillAgents["changelog-entries"]).toEqual(["investigator"]);
    expect(t.frame()).toContain("✓ saved the skill changelog-entries; loaded by investigator from their next run.");
    t.r.unmount();
  });

  it("a skill from a file, and one keel refuses is never offered", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "keel-skill-"));
    writeFileSync(join(dir, "SKILL.md"), SKILL.replace("agents: [investigator]\n", ""));
    writeFileSync(join(dir, "bad.md"), "# no front matter\n");
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.run(`/create skill --file ${join(dir, "bad.md")}`);
    expect(t.frame()).toContain("it has no front matter");
    expect(t.probe.pick).toBe(false);
    await t.run(`/create skill --file ${join(dir, "SKILL.md")}`);
    expect(t.frame()).toContain("no agent loads it yet (/skill attach)");
    await t.enter();
    expect(t.frame()).toContain("✓ saved the skill changelog-entries. Put it on agents: /skill attach changelog-entries <agent…>.");
    t.r.unmount();
  });

  it("reads a SKILL.md's front matter and what keel refuses in it", () => {
    expect(skillHead(SKILL)).toMatchObject({ name: "changelog-entries", description: "How to write a changelog entry.", agents: ["investigator"] });
    expect(skillProblems("---\nname: Big Name\ndescription: d\n---\ntext")).toEqual([
      'its name "Big Name" is not an id: lower-case words with dashes, like changelog-entries']);
    expect(skillProblems("---\nname: x\n---\n")).toEqual(["its front matter has no description (one sentence: what it teaches, when it is needed)",
      "it has no text after its front matter"]);
    expect(splitButtons("a\n```keel-skill\n" + SKILL + "\n```").buttons).toEqual([{ kind: "skill", text: SKILL + "\n" }]);
  });
});
