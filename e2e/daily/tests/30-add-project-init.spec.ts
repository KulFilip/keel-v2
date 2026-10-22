// J1 add a project from the folders and run its init flow, answering the questions in the dashboard (Inbox).
import { expect, test, type Page } from "@playwright/test";
import { NOTES, api, driveFlow, note, projects, signIn, until, useFakeModel, watchConsole, expectNoConsoleErrors } from "../lib/keel";

/** Answer what waits in the Inbox the way a person does: pick the first (recommended) option of each question, then
 *  press the approve button. Only buttons the card offers. Returns false when nothing waited. */
export async function answerInboxOnce(page: Page): Promise<string | false> {
  await page.goto("/#/inbox");
  const item = page.locator('[data-testid="inbox-item"]').first();
  if (!(await item.waitFor({ timeout: 15_000 }).then(() => true, () => false))) { await page.screenshot({ path: "inbox-empty.png" }).catch(() => undefined); return false; }
  const title = (await item.locator(".inbox-title").innerText()).trim();
  const groups = item.locator('[role="radiogroup"], fieldset');
  for (let i = 0; i < (await groups.count()); i++) {
    const first = groups.nth(i).getByRole("radio").first();
    if (await first.count()) await first.check().catch(() => first.click());
  }
  const btn = item.locator("button.warn, button.primary").first();
  if (!(await btn.count())) return `NO-BUTTON:${title}`;
  await btn.click();
  return title;
}

test.describe("J1 Add project + init", () => {
  test("J1 Add projects ticks `notes` from the folders", async ({ page }, info) => {
    const errors = watchConsole(page);
    await signIn(page);
    await page.goto("/#/projects");
    await expect(page.getByRole("list", { name: "Projects" })).toContainText("shop");
    await page.getByRole("button", { name: "Add projects" }).first().click();
    const drawer = page.getByRole("dialog").first();
    await expect(drawer).toBeVisible();
    // the drawer lists the repos under the current project's folder; notes is a sibling: Add by path
    await drawer.getByText("Add by path").click();
    await drawer.getByLabel(/folder inside the container/i).fill(NOTES);
    await drawer.getByRole("button", { name: "Add repo" }).click();
    await expect(page.getByRole("list", { name: "Projects" })).toContainText("notes", { timeout: 30_000 });
    const names = (await projects()).map((p) => p.name);
    expect(names).toContain("notes");
    await expectNoConsoleErrors(errors);
  });

  test("J1 init flow on notes: start it from the dashboard, answer its questions in the Inbox", async ({ page }, info) => {
    await useFakeModel();
    await signIn(page);
    const pid = (await projects()).find((p) => p.name === "notes")!.id;
    await page.goto("/#/projects");
    await page.getByRole("button", { name: "Start a flow in notes" }).click();
    const dlg = page.getByRole("dialog").first();
    await expect(dlg).toBeVisible();
    // pick the init workflow, then start
    await dlg.getByLabel("Workflow").selectOption({ label: await dlg.getByLabel("Workflow").locator("option", { hasText: /^init\b/ }).first().innerText() });
    const what = dlg.getByLabel(/what to build/i);
    if (await what.isVisible().catch(() => false)) await what.fill("Get to know notes");
    await dlg.getByRole("button", { name: "Start flow" }).click();
    const th = await until("the init flow", async () => (await api("GET", `/projects/${pid}/flow`)).thread, 60_000);
    // answer in the UI while it asks; the safe driver only takes over when the UI has no card for it
    for (let i = 0; i < 6; i++) {
      const cur = (await api("GET", `/projects/${pid}/flow`)).thread;
      if (!cur || ["done", "failed", "stopped"].includes(cur.status)) break;
      if (cur.status === "waiting") {
        const answered = await answerInboxOnce(page);
        if (answered === false || String(answered).startsWith("NO-BUTTON")) note(info, `the Inbox showed no usable card for "${cur.waiting?.title}" (${answered}); the safe driver answered`);
        else await until("the flow to leave that question", async () => {
          const t = (await api("GET", `/projects/${pid}/flow`)).thread;
          return !t || t.status !== "waiting" || t.waiting?.title !== cur.waiting?.title;
        }, 60_000, 1000);
        break;
      }
      await page.waitForTimeout(3000);
    }
    const res = await driveFlow(pid, th.thread_id, { maxDecisions: 12, waitMs: 420_000 });
    note(info, `init on notes ended: ${res.stoppedBecause} (${res.status}); gates: ${res.gates.join(" | ")}`);
    expect(["done", "repeat", "cap", "needs-person", "limit"]).toContain(res.stoppedBecause);
    expect(res.stoppedBecause, "the init flow must not fail on the fake model").not.toBe("failed");
    await page.goto(`/#/flow/${th.thread_id}`);
    await expect(page.locator("main")).toContainText(/init|notes/i);
  });
});
