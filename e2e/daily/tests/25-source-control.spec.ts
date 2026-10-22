// J6 source control panel: branch folders, a diff of an edited file, commit.
import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { api, bug, note, projectNamed, signIn, SHOP } from "../lib/keel";

test.describe("J6 Source control", () => {
  test("J6 branches grouped in folders, a diff for an edited file, commit", async ({ page }, info) => {
    await signIn(page);
    const shop = await projectNamed("shop");
    const price = path.join(SHOP, "shop/price.py");
    const original = fs.readFileSync(price, "utf8");
    fs.writeFileSync(price, original.replace("round(cents * (1 + rate))", "round(cents * (1 + rate), 0)  # edited by e2e"));
    try {
      await page.goto("/#/repo");
      await page.getByRole("button", { name: "Source control" }).first().click();
      // the edited file is listed as a change
      await expect(page.getByRole("button", { name: /Open the changes of shop\/price\.py/ })).toBeVisible({ timeout: 30_000 });
      // branch folders: feature/ and fix/
      const branches = page.getByRole("button", { name: /^Branches \d+/ });
      if ((await branches.getAttribute("aria-expanded")) === "false") await branches.click();
      const feature = page.getByRole("button", { name: /^feature\b.*\d/ }).first();
      await expect(feature, "the branches feature/cart and feature/checkout sit under a feature folder").toBeVisible();
      const leaf = (name: string) => page.locator(".scm-br", { hasText: name }).first();
      if (!(await leaf("feature/cart").isVisible())) await feature.click();
      await expect(leaf("feature/cart")).toBeVisible();
      await expect(leaf("feature/checkout")).toBeVisible();
      const fix = page.getByRole("button", { name: /^fix\b.*\d/ }).first();
      if (!(await leaf("fix/rounding").isVisible())) await fix.click();
      await expect(leaf("fix/rounding")).toBeVisible();
      await page.getByRole("button", { name: /Open the changes of shop\/price\.py/ }).click();
      await expect(page.locator(".dv-body")).toBeVisible();
      await expect(page.locator(".dv-row.add").first()).toContainText("edited by e2e");
      await expect(page.locator(".dv-row.del").first()).toContainText("round(cents * (1 + rate))");
      // commit through the Git plugin (off by default for a project: Control > Plugins; the api turns it on)
      await api("PUT", `/projects/${shop.id}/plugins/git`, { enabled: true, scope: "project" }, [200, 204]);
      const probe = await api("POST", `/projects/${shop.id}/git/commit`, { message: "chore: e2e edit", files: ["shop/price.py"] }, [200, 201, 400, 404, 409, 422]);
      note(info, `commit api answered: ${JSON.stringify(probe).slice(0, 200)}`);
      const log = execFileSync("git", ["-C", SHOP, "log", "--oneline", "-3"]).toString();
      if (!/e2e edit/.test(log)) bug(info, {
        title: "commit through the Git plugin api did not make a commit",
        steps: ["edit shop/price.py in the work tree", `POST /api/projects/${shop.id}/git/commit {message, files}`, "git log"],
        expected: "a commit 'chore: e2e edit'", actual: `git log: ${log.trim()}; api: ${JSON.stringify(probe).slice(0, 200)}`,
      });
    } finally {
      execFileSync("git", ["-C", SHOP, "checkout", "--", "."], { stdio: "ignore" });
      if (fs.readFileSync(price, "utf8") !== original && !/e2e edit/.test(execFileSync("git", ["-C", SHOP, "log", "--oneline", "-3"]).toString())) fs.writeFileSync(price, original);
    }
  });
});
