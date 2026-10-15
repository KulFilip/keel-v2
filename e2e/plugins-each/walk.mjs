// The web half of e2e/plugins-each/e2e.py: a keel with some plugins on and the others off, in headless Chromium.
//
//   npx -y -p playwright@1 node e2e/plugins-each/walk.mjs <url> <outdir> <off routes, a JSON object> [<hash> …]
//
// <off routes>: { "<plugin>": "<regex of its api paths>" } for every plugin that is OFF in this keel. The walk opens
// every page of the menu, #/projects and the extra pages it is given (a flow: #/flow/<thread>), each with a full load,
// and clicks the tabs of the main area. On each page it records the console errors, the failed requests (400 or more,
// or no answer), every request to an off plugin's api or web files (/plugins/<name>/…), and every link (main area,
// menu, dialogs) to a page this keel does not have (window.__keel.sdk.pageFor). It prints one JSON object:
// { checks: [{ what, ok, detail, shot }], pages: [registered page ids], menu: [hrefs] }.

import fs from "fs";
import { createRequire } from "module";
import os from "os";
import path from "path";

const [base, outDir, offJson, ...extra] = process.argv.slice(2);
if (!base || !outDir || !offJson) {
  console.error("usage: npx -y -p playwright@1 node e2e/plugins-each/walk.mjs <url> <outdir> <off routes JSON> [<hash> …]");
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });
const off = Object.entries(JSON.parse(offJson)).map(([name, re]) => [name, new RegExp(re), `/plugins/${name}/`]);

function loadPlaywright() {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir.endsWith(path.join("node_modules", ".bin"))) continue;
    try {
      return createRequire(path.join(dir, "..", "_.js"))("playwright");
    } catch {
      /* the next one */
    }
  }
  throw new Error("playwright not found: run me with npx -y -p playwright@1 node e2e/plugins-each/walk.mjs …");
}

/** Chromium: playwright's own, else the newest headless shell in the browser cache (as e2e/core/walk.mjs). */
async function launch(chromium) {
  try {
    return await chromium.launch();
  } catch (e) {
    const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), "Library/Caches/ms-playwright"),
      path.join(os.homedir(), ".cache/ms-playwright")].filter(Boolean);
    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      const shells = fs.readdirSync(root).filter((d) => d.startsWith("chromium_headless_shell-"))
        .sort((x, y) => Number(y.split("-")[1]) - Number(x.split("-")[1]));
      for (const d of shells) {
        for (const sub of fs.readdirSync(path.join(root, d))) {
          const exe = path.join(root, d, sub, "chrome-headless-shell");
          if (fs.existsSync(exe)) return chromium.launch({ executablePath: exe });
        }
      }
    }
    throw e;
  }
}

const MAX_TABS = 12;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
let shot = 0;

const { chromium } = loadPlaywright();
const browser = await launch(chromium);
const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, colorScheme: "light", reducedMotion: "reduce" });
const page = await ctx.newPage();
const seen = { console: [], failed: [], offAsked: [], inflight: new Map() };
const rel = (url) => {
  const u = new URL(url);
  return u.pathname + u.search;
};
page.on("console", (m) => {
  if (m.type() === "error") seen.console.push(m.text().replaceAll(base, "").slice(0, 300));
});
page.on("pageerror", (e) => seen.console.push("page error: " + String(e.message).slice(0, 300)));
page.on("request", (r) => {
  seen.inflight.set(r, Date.now());
  if (!r.url().startsWith(base)) return;
  const p = new URL(r.url()).pathname;
  for (const [name, re, web] of off) if (re.test(p) || p.startsWith(web)) seen.offAsked.push(`${name}: ${r.method()} ${rel(r.url())}`);
});
page.on("requestfinished", (r) => seen.inflight.delete(r));
page.on("requestfailed", (r) => {
  seen.inflight.delete(r);
  const why = r.failure()?.errorText ?? "";
  if (!/ERR_ABORTED|NS_BINDING_ABORTED/.test(why)) seen.failed.push(`${r.method()} ${rel(r.url())} ${why}`);
});
page.on("response", (res) => {
  if (res.status() >= 400) seen.failed.push(`${res.request().method()} ${rel(res.url())} → ${res.status()}`);
});

// Failed requests keel 0.16.1 makes too (parity.py lists them as notes): the fixture has no GitHub remote, so CI/CD's
// runs and Git's pull request answer 400. They are not a plugin problem; each takes its console line with it.
const KNOWN = [/^GET \/api\/projects\/[^/]+\/ci\/runs(\?\S*)? → 400$/, /^GET \/api\/projects\/[^/]+\/git\/pr(\?\S*)? → 400$/];
const LOAD_400 = /^Failed to load resource: the server responded with a status of 400/;

function withoutKnown(failed, consoleLines) {
  const left = failed.filter((f) => !KNOWN.some((re) => re.test(f)));
  let drop = failed.length - left.length;
  const lines = consoleLines.filter((c) => !(drop > 0 && LOAD_400.test(c) && drop--));
  return [left, lines];
}

async function check(what, ok, detail = "") {
  let file = "";
  if (!ok) {
    file = path.join(outDir, `failed-${++shot}.png`);
    await page.screenshot({ path: file }).catch(() => (file = ""));
  }
  checks.push({ what, ok: !!ok, detail: String(detail).slice(0, 1500), shot: file });
}

async function settle(max = 12000) {
  const t0 = Date.now();
  await page.waitForSelector("main", { timeout: max }).catch(() => {});
  let last = "";
  let still = Date.now();
  while (Date.now() - t0 < max) {
    const sig = await page.evaluate(() => {
      const m = document.querySelector("main");
      const loading = !!document.querySelector("main .pg-spin, main .pg-skel, .empty.loading");
      return `${loading ? "loading " : ""}${m ? `${m.innerHTML.length}:${m.getElementsByTagName("*").length}` : "-"}`;
    }).catch(() => "loading");
    const busy = [...seen.inflight].some(([r, at]) => Date.now() - at < 5000 && r.resourceType() !== "eventsource" && !r.url().includes("/api/events"));
    if (sig !== last || sig.startsWith("loading")) {
      last = sig;
      still = Date.now();
    } else if (Date.now() - still > 600 && !busy) return;
    await wait(100);
  }
}

function deadLinks(where = "main a[href^='#'], nav a[href^='#'], [role=dialog] a[href^='#']") {
  return page.evaluate((sel) => {
    const sdk = window.__keel?.sdk;
    const own = new Set(["projects"]);
    const out = [];
    for (const a of document.querySelectorAll(sel)) {
      const href = a.getAttribute("href") ?? "";
      if (!href.startsWith("#/")) {
        if (href.length > 1 && !document.getElementById(href.slice(1))) out.push(`${href} (no such element)`);
        continue;
      }
      const first = decodeURIComponent(href.slice(2).split(/[/?]/)[0]);
      if (!first || own.has(first) || sdk?.pageFor(first)) continue;
      out.push(`${href} "${(a.getAttribute("aria-label") || a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 50)}"`);
    }
    return [...new Set(out)];
  }, where);
}

function missingText() {
  return page.evaluate(() => {
    const t = document.querySelector("main")?.textContent ?? "";
    return /is not in this keel|could not be loaded/.test(t) ? t.replace(/\s+/g, " ").slice(0, 200) : "";
  });
}

async function visit(hash) {
  seen.console = [];
  seen.failed = [];
  seen.offAsked = [];
  seen.inflight.clear();
  await page.goto("about:blank");
  await page.goto(`${base}/${hash}`);
  await settle();
  const dead = new Set(await deadLinks());
  const missing = await missingText();
  const tabs = [];
  const lists = await page.locator("main [role=tablist]").count();
  let clicked = 0;
  for (let i = 0; i < lists && clicked < MAX_TABS; i++) {
    const list = page.locator("main [role=tablist]").nth(i);
    const n = await list.locator("[role=tab]").count().catch(() => 0);
    for (let j = 0; j < n && clicked < MAX_TABS; j++) {
      const tab = list.locator("[role=tab]").nth(j);
      const name = ((await tab.textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
      try {
        await tab.click({ timeout: 4000 });
        clicked++;
        await settle(8000);
        tabs.push(name);
        for (const d of await deadLinks()) dead.add(`${d} (tab ${name})`);
      } catch {
        /* a tab that went away when another was clicked */
      }
    }
  }
  const [failed, lines] = withoutKnown(seen.failed, seen.console);
  return { console: [...new Set(lines)], failed: [...new Set(failed)], offAsked: [...new Set(seen.offAsked)],
    dead: [...dead], missing, tabs };
}

let pages = [];
let menu = [];
try {
  const projects = await (await ctx.request.get(`${base}/api/projects`)).json().catch(() => []);
  const pid = projects[0]?.id ?? "";
  await page.goto(`${base}/#/projects`);
  await page.evaluate((p) => localStorage.setItem("keel2.project", p), pid);
  await check("a project to show", !!pid, JSON.stringify(projects.map((p) => p.id)));

  // ---- the menu and the page registry, once the plugins' web parts have loaded
  seen.console = [];
  seen.failed = [];
  seen.offAsked = [];
  await page.goto("about:blank");
  await page.goto(`${base}/#/flow`);
  await settle();
  await wait(2500);
  pages = await page.evaluate(() => (window.__keel?.sdk?.allPages?.() ?? []).map((p) => p.id).sort());
  menu = await page.evaluate(() => [...document.querySelectorAll("nav#nav .nav-sec a")].map((a) => a.getAttribute("href")));
  const [startFailed, startConsole] = withoutKnown(seen.failed, seen.console);
  const startBad = [...startConsole, ...startFailed, ...seen.offAsked.map((x) => `off plugin asked: ${x}`)];
  await check("start: no console error, failed request or request to an off plugin", !startBad.length, startBad.join(" | "));

  // ---- every page
  const hashes = [...new Set(["#/projects", ...menu, ...extra])];
  for (const hash of hashes) {
    const r = await visit(hash);
    const bad = [
      ...r.console.map((x) => `console: ${x}`),
      ...r.failed.map((x) => `failed: ${x}`),
      ...r.offAsked.map((x) => `off plugin asked: ${x}`),
      ...r.dead.map((x) => `link to a missing page: ${x}`),
      ...(r.missing ? [`shows: ${r.missing}`] : []),
    ];
    await check(`${hash}${r.tabs.length ? ` (+${r.tabs.length} tabs)` : ""}: no console error, failed request, off plugin's route or dead link`,
      bad.length === 0, bad.join(" | "));
  }
} catch (e) {
  checks.push({ what: "the walk ran to its end", ok: false, detail: String(e?.stack || e).slice(0, 1500), shot: "" });
} finally {
  await browser.close();
}
console.log(JSON.stringify({ checks, pages, menu }));
