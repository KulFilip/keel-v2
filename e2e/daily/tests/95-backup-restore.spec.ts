// J12 launcher backup -> a corrupt restore is refused with the data intact -> a good restore. Runs last: it stops keel.
import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { api, bug, KEEL2, note, projects, projectNamed, raw, startFlow, until, useFakeModel, WORK } from "../lib/keel";

const k2 = (...a: string[]) => spawnSync(KEEL2, a, { encoding: "utf8", timeout: 300_000, env: { ...process.env, NO_COLOR: "1" } });

test.describe("J12 Backup and restore", () => {
  test("J12 backup; corrupt restores are refused with the data intact; the good restore works", async ({}, info) => {
    await useFakeModel();
    const shop = await projectNamed("shop");
    const before = (await projects()).map((p) => p.name).sort();
    const countFlows = async () => { const r = await raw("GET", `/api/projects/${shop.id}/flows`); return r.status === 200 && Array.isArray(r.json) ? r.json.length : -1; };
    const flows0 = await countFlows();

    const good = path.join(WORK, "good.tgz");
    const b = k2("backup", good);
    expect(b.status, "keel2 backup: " + (b.stderr + b.stdout).slice(-400)).toBe(0);
    expect(fs.statSync(good).size).toBeGreaterThan(1000);

    // something happens after the backup: a flow
    const tid = await startFlow(shop.id, "feature", "after the backup", { request: "x" });
    await api("POST", `/threads/${tid}/stop`, undefined, [200, 204, 409]).catch(() => undefined);
    const flows1 = await countFlows();

    // corrupt files: random bytes, a truncated tgz, a tgz without keel.db, a tgz with unsafe paths
    const garbage = path.join(WORK, "garbage.tgz"); fs.writeFileSync(garbage, "this is not a tar file\n".repeat(50));
    const trunc = path.join(WORK, "trunc.tgz"); fs.writeFileSync(trunc, fs.readFileSync(good).subarray(0, 300));
    const nodb = path.join(WORK, "nodb.tgz"); fs.writeFileSync(path.join(WORK, "x.txt"), "x"); spawnSync("tar", ["-czf", nodb, "-C", WORK, "x.txt"]);
    const evil = path.join(WORK, "evil.tgz"); spawnSync("tar", ["-czPf", evil, path.join(WORK, "x.txt")]);
    for (const [what, f] of [["garbage", garbage], ["truncated", trunc], ["no keel.db", nodb], ["absolute paths", evil]] as const) {
      const r = k2("restore", f);
      if (r.status === 0) bug(info, { title: `keel2 restore accepted a corrupt backup (${what})`, steps: [`keel2 restore ${f}`], expected: "refused (exit != 0), nothing changed", actual: "exit 0" });
      expect(r.status, `restore of a ${what} file must be refused`).not.toBe(0);
      const h = await raw("GET", "/api/health", { key: null });
      expect(h.status, `keel still answers after the refused ${what} restore`).toBe(200);
      expect((await projects()).map((p) => p.name).sort(), `projects intact after ${what}`).toEqual(before);
      expect(await countFlows(), `flow history intact after ${what}`).toBe(flows1);
    }
    // the good one
    const r = k2("restore", good);
    expect(r.status, "good restore: " + (r.stderr + r.stdout).slice(-500)).toBe(0);
    const key = k2("auth", "key").stdout.trim();
    if (key) process.env.KEEL_KEY = key;
    await until("keel after the restore", async () => (await raw("GET", "/api/health", { key: null })).status === 200, 180_000, 2000);
    const ok = await until("projects after the restore", async () => { const p = await raw("GET", "/api/projects", { key: key || undefined }); return p.status === 200 ? p : null; }, 120_000, 2000);
    expect(ok.json.map((p: any) => p.name).sort()).toEqual(before);
    if (flows0 >= 0) {
      const now = await raw("GET", `/api/projects/${shop.id}/flows`, { key: key || undefined });
      note(info, `flows: before backup ${flows0}, after the extra flow ${flows1}, after restore ${Array.isArray(now.json) ? now.json.length : "?"}`);
      expect(Array.isArray(now.json) ? now.json.length : -1, "the restore brought back the state of the backup").toBe(flows0);
    }
  });
});
