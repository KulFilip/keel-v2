// J0 security: the api answers nobody without the sign-in key, however the path is spelled.
import { expect, test } from "@playwright/test";
import { raw, URL_ } from "../lib/keel";

test.describe("J0 Security", () => {
  test("J0 an unsigned caller gets 401/400 for every spelling of /api/projects", async () => {
    const base = await raw("GET", "/api/projects");
    expect(base.status, "baseline: /api/projects with the key").toBe(200);
    expect(Array.isArray(base.json)).toBeTruthy();

    const spellings = [
      "/api/projects", "/api;x=1/projects", "/%61pi/projects", "/api/%70rojects", "/api//projects", "//api/projects",
      "/api/./projects", "/api/projects/", "/api/projects;a=b", "/API/projects", "/api/projects%00", "/api/x/../projects",
      "/%2e/api/projects", "/api%2fprojects", "/api/projects.xml", "/api;/projects", "/api/projects?x=1#y",
    ];
    const bad: string[] = [];
    for (const p of spellings) {
      const r = await raw("GET", p, { key: null });
      const leaks = r.json && JSON.stringify(r.json).includes(base.json[0].id);
      const isPage = r.status === 200 && /^\s*<(!doctype|html)/i.test(r.text); // the web app's own page is public
      if ((![400, 401, 403, 404].includes(r.status) && !isPage) || leaks) bad.push(`${p} -> ${r.status} ${r.headers["content-type"] ?? ""} ${r.text.slice(0, 80).replace(/\s+/g, " ")}${leaks ? " LEAKS the project list" : ""}`);
      // the two spellings named in the plan must be exactly 401 or 400
      if ((p === "/api;x=1/projects" || p === "/%61pi/projects") && ![400, 401].includes(r.status)) bad.push(`${p} must be 401/400, got ${r.status}`);
    }
    expect(bad, "unsigned requests that were answered").toEqual([]);
  });

  test("J0 a wrong key and a wrong scheme are refused; writes too", async () => {
    for (const key of ["wrong", "0".repeat(64)]) {
      const r = await raw("GET", "/api/projects", { key });
      expect([400, 401, 403], `key ${key.slice(0, 6)}`).toContain(r.status);
    }
    const basic = await raw("GET", "/api/projects", { key: null, headers: { Authorization: "Basic dXNlcjpwYXNz" } });
    expect([400, 401, 403]).toContain(basic.status);
    const post = await raw("POST", "/api/projects/x/flows", { key: null, body: { workflow_id: "init", title: "x" } });
    expect([400, 401, 403, 404]).toContain(post.status);
    const code = await raw("POST", "/api/web/code", { key: null, body: {} });
    expect([400, 401, 403], "no sign-in link without the key").toContain(code.status);
    const spoof = await raw("GET", "/api/projects", { key: null, headers: { "X-Forwarded-For": "127.0.0.1", "X-Real-IP": "127.0.0.1", Host: "localhost" } });
    expect([400, 401, 403], "a forwarded-for header is not a credential").toContain(spoof.status);
  });

  test("J0 the page itself loads without a key but shows no data", async ({ page }) => {
    const r = await page.goto(URL_ + "/");
    expect(r?.status()).toBeLessThan(500);
    const html = await page.content();
    expect(html).not.toContain("shop");
  });
});
