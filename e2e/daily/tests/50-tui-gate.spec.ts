// J4 answer a gate from the keel TUI (scripted .tui) and see it in the dashboard.
import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { api, bug, KEEL2, note, projectNamed, signIn, SHOP, startFlow, until, useFakeModel, WORK } from "../lib/keel";

test.describe("J4 TUI gate", () => {
  test("J4 /approve in keel TUI moves the flow, the dashboard shows it", async ({ page }, info) => {
    await useFakeModel();
    const shop = await projectNamed("shop");
    // an idle project first
    const cur = (await api("GET", `/projects/${shop.id}/flow`)).thread;
    if (cur && !["done", "failed", "stopped"].includes(cur.status)) await api("POST", `/threads/${cur.thread_id}/stop`, undefined, [200, 204, 409]);
    const tid = await startFlow(shop.id, "feature", "TUI gate", { request: "Save a score." });
    const w = await until("a waiting gate", async () => {
      const t = (await api("GET", `/projects/${shop.id}/flow`)).thread;
      return t?.thread_id === tid && t.status === "waiting" ? t : null;
    }, 240_000);
    const step0 = w.waiting.step, title0 = w.waiting.title;
    // a clarify question needs an answer, not /approve: skip those with the plain driver of the TUI (enter picks the recommended)
    const out = path.join(WORK, "tui-out");
    fs.mkdirSync(out, { recursive: true });
    const script = path.join(__dirname, "..", "tui", "answer-gate.tui");
    const r = spawnSync(KEEL2, ["tui", "--script", script, "--out", out, "--width", "100"], { cwd: SHOP, encoding: "utf8", timeout: 180_000, env: { ...process.env, FORCE_COLOR: "0" } });
    note(info, `keel2 tui exit ${r.status}; snaps: ${fs.readdirSync(out).join(", ")}`);
    expect(r.status, `keel2 tui --script failed: ${(r.stderr || r.stdout).slice(-600)}`).toBe(0);
    const next = fs.readFileSync(path.join(out, "02-next.txt"), "utf8");
    expect(next.toLowerCase(), "/next names the waiting gate").toMatch(/waiting|approve|gate|question|spec/);
    // the dashboard: the flow is not at that gate any more
    const moved = await until("the flow past the gate", async () => {
      const t = (await api("GET", `/projects/${shop.id}/flow`)).thread;
      return t && (t.status !== "waiting" || t.waiting?.step !== step0 || t.waiting?.title !== title0) ? t : null;
    }, 120_000).catch(() => null);
    if (!moved) bug(info, {
      title: "/approve in keel TUI did not move the flow",
      steps: ["start a feature flow on the fake model", `wait for the gate '${title0}'`, "keel2 tui --script: /next, /approve"],
      expected: "the flow leaves the gate", actual: "still at the same gate after 120 s; 03-approved.txt: " + fs.readFileSync(path.join(out, "03-approved.txt"), "utf8").slice(-400),
    });
    await signIn(page);
    await page.goto(`/#/flow/${tid}`);
    await expect(page.locator("main")).toContainText(/TUI gate/);
    const log = (await api("GET", `/threads/${tid}`).catch(() => ({}))) as any;
    note(info, `gate_log: ${JSON.stringify(log.gate_log ?? log.thread?.gate_log ?? []).slice(0, 300)}`);
    await api("POST", `/threads/${tid}/stop`, undefined, [200, 204, 409]).catch(() => undefined);
  });
});
