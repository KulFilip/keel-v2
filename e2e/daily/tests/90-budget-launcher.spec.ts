// J10 the budget page's numbers against the api; J11 the launcher (Ctrl/Cmd+K).
import { expect, test } from "@playwright/test";
import { api, projectNamed, signIn, watchConsole, expectNoConsoleErrors } from "../lib/keel";

const kfmt = (n: number) => { const v = Number(n) || 0; return Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(2) + "M" : Math.abs(v) >= 1e3 ? Math.round(v / 1e3) + "k" : String(Math.round(v)); };
const usd = (n: number) => "$" + (Number(n) || 0).toFixed(2);

test.describe("J10 Budget", () => {
  test("J10 this month's tokens, cost and flows equal the api", async ({ page }) => {
    const errors = watchConsole(page);
    await signIn(page);
    const shop = await projectNamed("shop");
    const b = await api("GET", `/projects/${shop.id}/budget`);
    await page.goto("/#/budget");
    const kpis = page.locator(".bd-month, .bd-kpis").first();
    await expect(kpis).toBeVisible({ timeout: 30_000 });
    const text = await kpis.innerText();
    expect(text, "tokens").toContain(kfmt(b.month.tokens));
    expect(text, "cost").toContain(usd(b.month.cost_usd));
    const flowsCell = await kpis.locator("div", { hasText: /^Flows/ }).first().innerText();
    expect(flowsCell).toContain(String(b.month.flows));
    // the "now" numbers behind the budget bar
    const now = await api("GET", `/projects/${shop.id}/budget/now`);
    expect(now.today.tokens).toBeLessThanOrEqual(b.month.tokens + 1);
    await expectNoConsoleErrors(errors);
  });
});

test.describe("J11 Launcher", () => {
  test("J11 Ctrl+K opens the launcher; typing 'budget' and Enter goes to the Budget page", async ({ page }) => {
    await signIn(page);
    await page.goto("/#/projects");
    await page.locator("main").click();
    await page.keyboard.press("Control+k");
    const dlg = page.getByRole("dialog").first();
    await expect(dlg).toBeVisible();
    await page.keyboard.type("budget");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/budget/);
  });
});
