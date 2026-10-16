// Records the README GIF from a REAL keel v2 dashboard while a flow runs (nothing is drawn or mocked).
//
//   1. Start keel on a small scratch project (with SQL migrations, so the Map has a database diagram, and one spec in
//      its spec folder, so the Wiki shows a spec's build status) and start a feature flow from that spec; let it run
//      until a gate waits.
//   2. npx -y -p playwright@1 node docs/gif/record.js          (URL=http://localhost:8080 by default)
//   3. ffmpeg -i docs/gif/out/*.webm -vf "fps=6,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" docs/keel-v2.gif
//      (about 5 MB for 42 seconds; 8 fps and 128 colours make it 8 MB)
//
// The tour, with the budget bar on top all the way: all projects, the live flow, the inbox, Control › Plugins (keel
// core "always on", a plugin's [Off | This project | All projects] control), the Code plugin's page, the database
// diagram, the code graph (packages, then one), the Wiki (a section closes and opens, the spec page with its build
// status and "Open the flow"), the repo, then the gate: it clicks Approve for real.
// v0.17.3: a throw-away NATIVE keel (keel2 start --native --from-tarball, KEEL_FAKE=1, its own KEEL2_HOME) on the
// parity test's shop with docs/specs/refunds.md, a feature flow started from that spec on keel's fake model:
//   URL=http://127.0.0.1:8389 npx -y -p playwright@1 node docs/gif/record.js
const fs = require("fs");
const os = require("os");
const path = require("path");

/** playwright from `npx -p playwright@1`: npx puts its node_modules/.bin on PATH (as e2e/parity/pages.mjs finds it). */
function loadPlaywright() {
  try { return require("playwright"); } catch { /* npx's own folder below */ }
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir.endsWith(path.join("node_modules", ".bin"))) continue;
    try { return require(path.join(dir, "..", "playwright")); } catch { /* the next one */ }
  }
  throw new Error("playwright not found: run me with npx -y -p playwright@1 node docs/gif/record.js");
}

/** Chromium: playwright's own, else the newest headless shell in the browser cache (as e2e/parity/pages.mjs). */
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

const BASE = process.env.URL || "http://localhost:8080";
const OUT = process.env.OUT || path.join(__dirname, "out");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { chromium } = loadPlaywright();
  const browser = await launch(chromium);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 }, colorScheme: "dark",
    recordVideo: { dir: OUT, size: { width: 1280, height: 760 } } });
  const page = await ctx.newPage();
  const go = async (hash, ms) => {
    await page.goto(`${BASE}/#/${hash}`);
    await page.waitForLoadState("networkidle").catch(() => {});
    await wait(ms);
  };
  /** Move the pointer to an element like a person would and rest there. */
  const point = async (locator, pause = 700) => {
    const el = locator.first();
    if (!(await el.count())) return null;
    await el.scrollIntoViewIfNeeded().catch(() => {});
    const box = await el.boundingBox();
    if (box) { await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 16), { steps: 14 }); await wait(pause); }
    return el;
  };
  /** Point at an element, then double-click (or click) it. */
  const press = async (locator, { double = false, pause = 600 } = {}) => {
    const el = await point(locator, pause);
    if (!el) return false;
    try {
      if (double) await el.dblclick({ timeout: 3000 }); else await el.click({ timeout: 3000 });
    } catch { return false; }
    return true;
  };

  // the project whose flow waits for you is the current one, and the Map opens on its database diagram
  const pid = await page.goto(`${BASE}/api/projects`).then((r) => r.json())
    .then((l) => ([...l].sort((a, b) => (b.waiting || 0) - (a.waiting || 0))[0] || {}).id).catch(() => null);
  await page.goto(`${BASE}/#/projects`);
  if (pid) {
    await page.evaluate((p) => {
      localStorage.setItem("keel2.project", p);
      localStorage.setItem(`keel2.map.${p}.tab`, "er");
      localStorage.removeItem(`keel.wiki.closed.${p}`);
    }, pid);
    await page.reload(); // the app read its project at load: a hash change alone would keep the first one
  }

  await go("projects", 2200);
  await go("flow", 1600);
  await page.mouse.move(700, 420);
  for (let i = 0; i < 2; i++) { await page.mouse.wheel(0, 360); await wait(500); }
  await page.mouse.wheel(0, -3000); await wait(400);
  await go("inbox", 1800);
  // Control › Plugins: keel core is always on; a project's plugin has one control [Off | This project | All projects]
  await go("plugins", 1200);
  await point(page.getByText("always on", { exact: true }), 1000);
  await point(page.getByRole("radiogroup").getByRole("radio", { name: "This project" }), 800);
  await point(page.getByRole("radiogroup").getByRole("radio", { name: "All projects" }), 1000);
  await go("plugins/code", 2200);
  await go("map", 2600);
  await go("graph", 1600);
  if (await press(page.locator("g.gbox", { hasText: "web" }), { double: true })) await wait(2400);
  // 0.17.3 Wiki (it opens on the spec): a section closes and opens again, the spec's pill, its build status
  await go("wiki", 1000);
  // (the open page's own section stays open: its button is aria-disabled)
  const sec = page.locator('button.wt-h:not([aria-disabled="true"])', { hasText: /knowledge/i });
  if (await press(sec, { pause: 600 })) { await wait(900); await press(sec, { pause: 400 }); await wait(500); }
  await point(page.locator(".wtree .wk-sp"), 700);
  await point(page.locator(".wk-build .wk-sp"), 700);
  await point(page.getByRole("link", { name: "Open the flow" }), 1200);
  await go("repo", 2000);
  await go("flow", 1400);
  // "Go to it" brings the waiting gate into view; its decision buttons are named by the choice ("approve")
  if (await press(page.getByRole("button", { name: "Go to it" }), { pause: 700 })) await wait(1200);
  await press(page.getByRole("button", { name: "approve", exact: true }), { pause: 900 });
  await wait(2800);
  await ctx.close(); await browser.close();
})();
