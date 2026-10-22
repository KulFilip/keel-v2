// J5 Code view with a REAL mouse wheel: the right element scrolls, the page does not jam, Cmd/Ctrl+A selects only the
// file text. (Fixes: c9612ecc "size the Code page with CSS only", f493bad7 "scroll panes by scrollTop, select-all per pane".)
import { expect, test, type Page } from "@playwright/test";
import { signIn, watchConsole, expectNoConsoleErrors, bug } from "../lib/keel";

const SELECT_ALL = process.platform === "darwin" ? "Meta+A" : "Control+A";

/** scrollTop of the window and of every scroller on the page, by a short name. */
async function scrollers(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const out: Record<string, number> = { window: Math.round(window.scrollY), doc: Math.round(document.scrollingElement?.scrollTop ?? 0) };
    document.querySelectorAll<HTMLElement>("*").forEach((el) => {
      if (el.scrollHeight > el.clientHeight + 2 && /(auto|scroll)/.test(getComputedStyle(el).overflowY) || el.scrollTop > 0) {
        const name = (el.getAttribute("aria-label") || el.className || el.tagName).toString().slice(0, 40);
        out[`${el.tagName.toLowerCase()}[${name}]`] = Math.round(el.scrollTop);
      }
    });
    return out;
  });
}

async function wheelOver(page: Page, selector: string, dy: number, times = 1) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 200));
  for (let i = 0; i < times; i++) {
    await page.mouse.wheel(0, dy);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(250);
}

const top = (page: Page, sel: string) => page.locator(sel).first().evaluate((e: HTMLElement) => e.scrollTop);

async function open(page: Page, file: string) {
  await page.goto(`/#/repo/${file}:1`);
  await expect(page.getByRole("region", { name: new RegExp(`Code of ${file.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}|Rendered Markdown`) }).first()).toBeVisible({ timeout: 30_000 });
}

test.describe("J5 Code view", () => {
  test("J5 a long Python file: the wheel scrolls .cv, not the page", async ({ page }, info) => {
    const errors = watchConsole(page);
    await signIn(page);
    await open(page, "big/inventory.py");
    const before = await scrollers(page);
    const cvTop0 = await top(page, ".cv");
    // a real wheel over the file body, 12 notches
    const t0 = Date.now();
    await wheelOver(page, ".cv", 240, 12);
    const took = Date.now() - t0;
    const cvTop1 = await top(page, ".cv");
    const after = await scrollers(page);
    expect(cvTop1, "the file body scrolled (.cv scrollTop)").toBeGreaterThan(cvTop0 + 500);
    expect(after.window, "the window did not scroll").toBe(0);
    expect(after.doc, "the document did not scroll").toBe(0);
    const moved = Object.keys(after).filter((k) => after[k] !== (before[k] ?? 0));
    expect(moved.filter((k) => !k.includes("Code of")), "only the file body moved").toEqual([]);
    expect(took, "12 wheel notches took too long: the page is jammed").toBeLessThan(8000);
    // and back up: the first lines come back
    await wheelOver(page, ".cv", -240, 30);
    expect(await top(page, ".cv"), "scrolls back to the top").toBeLessThan(5);
    // the line numbers shown follow the scroll (the virtual list renders the visible lines)
    await wheelOver(page, ".cv", 400, 12);
    // the line at the top edge of the file body follows the scroll (the list may render every line: look at the viewport)
    const first = await page.locator(".cv").first().evaluate((cv: HTMLElement) => {
      const top = cv.getBoundingClientRect().top;
      const row = [...cv.querySelectorAll<HTMLElement>(".cv-row")].find((r) => r.getBoundingClientRect().bottom > top + 4);
      return row?.dataset.line;
    });
    expect(Number(first), "the line at the top of the file body moved on").toBeGreaterThan(20);
    await expectNoConsoleErrors(errors);
  });

  test("J5 a Kotlin file and the tab bar, the path bar: the wheel over them never jams the page", async ({ page }, info) => {
    await signIn(page);
    await open(page, "big/inventory.py");
    await open(page, "big/Stock.kt");
    await expect(page.locator(".ed-tabs [role=tab]").first()).toBeVisible();
    for (const [what, sel] of [["tab bar", ".ed-tabs"], ["path bar", ".crumbs"], ["toolbar", ".ed-tools"], ["top of the editor", ".ed-head"]] as const) {
      const loc = page.locator(sel).first();
      if (!(await loc.count())) { info.annotations.push({ type: "note", description: `no ${sel}` }); continue; }
      const s0 = await scrollers(page);
      const box0 = await page.locator(".ide").first().boundingBox();
      await wheelOver(page, sel, 300, 6);
      const s1 = await scrollers(page);
      const box1 = await page.locator(".ide").first().boundingBox();
      expect(s1.window, `wheel over the ${what}: window`).toBe(0);
      expect(s1.doc, `wheel over the ${what}: document`).toBe(0);
      expect(box1?.y, `wheel over the ${what}: the IDE did not move`).toBe(box0?.y);
      expect(Object.keys(s1).filter((k) => s1[k] !== (s0[k] ?? 0) && !k.includes("tablist") && !k.includes("Open files")), `wheel over the ${what}: nothing scrolled`).toEqual([]);
      // and the file body still answers the wheel right after (no jam)
      const t = await top(page, ".cv");
      await wheelOver(page, ".cv", 200, 4);
      expect(await top(page, ".cv"), `after the ${what}, the file body still scrolls`).toBeGreaterThan(t);
      await wheelOver(page, ".cv", -200, 8);
    }
  });

  test("J5 a short file: the wheel over it does nothing odd, and the next long file scrolls", async ({ page }) => {
    await signIn(page);
    await open(page, "tiny.txt");
    const s0 = await scrollers(page);
    await wheelOver(page, ".cv", 500, 5);
    const s1 = await scrollers(page);
    expect(s1.window, "short file: window").toBe(0);
    expect(s1.doc, "short file: document").toBe(0);
    expect(await top(page, ".cv"), "short file: nothing to scroll").toBeLessThan(80);
    expect(Object.keys(s1).filter((k) => !k.includes("Code of") && s1[k] !== (s0[k] ?? 0)), "short file: no other element moved").toEqual([]);
    await open(page, "big/Stock.kt");
    await wheelOver(page, ".cv", 300, 6);
    expect(await top(page, ".cv"), "a long file after a short one scrolls").toBeGreaterThan(300);
  });

  test("J5 the Markdown pane: preview scrolls .md-pane", async ({ page }) => {
    await signIn(page);
    await open(page, "docs/GUIDE.md");
    await page.getByRole("button", { name: "Preview" }).click();
    await expect(page.getByRole("region", { name: "Rendered Markdown" })).toBeVisible();
    const s0 = await scrollers(page);
    await wheelOver(page, ".md-pane", 300, 10);
    expect(await top(page, ".md-pane"), "the rendered Markdown scrolled").toBeGreaterThan(400);
    const s1 = await scrollers(page);
    expect(s1.window + s1.doc, "the page itself did not scroll").toBe(0);
    expect(Object.keys(s1).filter((k) => !k.includes("md-pane") && !k.includes("Rendered") && s1[k] !== (s0[k] ?? 0))).toEqual([]);
    // and the other way: back to the code view, which scrolls too
    await page.getByRole("button", { name: "Preview" }).click();
    await wheelOver(page, ".cv", 300, 6);
    expect(await top(page, ".cv")).toBeGreaterThan(300);
  });

  test("J5 select-all in the editor selects only the file text", async ({ page }, info) => {
    await signIn(page);
    await open(page, "shop/price.py");
    await page.locator(".cv .cv-row").nth(1).locator(".cv-code").click();
    await page.keyboard.press(SELECT_ALL);
    const sel = await page.evaluate(() => {
      const s = window.getSelection()!;
      const cv = document.querySelector(".cv");
      const inside = (n: Node | null) => !!n && !!cv && cv.contains(n);
      return { text: s.toString(), anchorIn: inside(s.anchorNode), focusIn: inside(s.focusNode), n: s.rangeCount };
    });
    expect(sel.text, "the selection holds the file text").toContain("def with_tax");
    expect(sel.text).toContain("return round(cents");
    for (const other of ["Explorer", "Filter files", "Changes", "shop/price.py", "README.md"]) {
      expect(sel.text, `the selection must not hold "${other}"`).not.toContain(other);
    }
    expect(sel.anchorIn && sel.focusIn, "the selection starts and ends inside the file body").toBeTruthy();
    // the same in the long file: it holds its first line, not the explorer
    await open(page, "big/inventory.py");
    await page.locator(".cv .cv-row").nth(3).locator(".cv-code").click();
    await page.keyboard.press(SELECT_ALL);
    const long = await page.evaluate(() => ({ t: window.getSelection()!.toString(), inCv: !!document.querySelector(".cv")?.contains(window.getSelection()!.anchorNode) }));
    expect(long.inCv).toBeTruthy();
    expect(long.t).not.toContain("Explorer");
    expect(long.t.length, "something was selected").toBeGreaterThan(200);
  });

  test("J5 path bar and tab bar show the open file; the explorer opens a file by click", async ({ page }) => {
    await signIn(page);
    await page.goto("/#/repo");
    const tree = page.getByRole("tree", { name: "Files" });
    await expect(tree).toBeVisible({ timeout: 30_000 });
    await tree.locator('[data-path="big"]').click();
    await tree.locator('[data-path="big/inventory.py"]').dblclick(); // a double click keeps the tab (a single click is a preview tab that the next click replaces)
    await expect(page.locator(".crumbs .crumb-f")).toHaveText("inventory.py");
    await expect(page.locator('.ed-tabs [role=tab][aria-selected="true"]')).toContainText("inventory.py");
    await tree.locator('[data-path="big/Stock.kt"]').click();
    await expect(page.locator('.ed-tabs [role=tab]')).toHaveCount(2);
    await expect(page.locator(".crumbs")).toContainText("big");
    await page.locator(".ed-tabs [role=tab]", { hasText: "inventory.py" }).click();
    await expect(page.locator(".crumbs .crumb-f")).toHaveText("inventory.py");
  });
});
