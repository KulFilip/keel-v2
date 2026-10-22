// summary.md: pass/fail per journey, and the bugs the journeys saw. A journey reports a keel bug with lib/keel.ts
// `bug(...)` (an annotation of type "bug": steps, expected, actual; the failing assertion's screenshot is attached).
// A plain failed assertion is listed as "failed" - read it: it is a keel bug or a harness problem.
import fs from "node:fs";
import path from "node:path";

const strip = (s) => String(s || "").replace(/\x1b\[[0-9;]*m/g, "");

export default class SummaryReporter {
  constructor(opts) {
    this.out = opts.out;
    this.rows = [];
    this.t0 = Date.now();
  }
  onTestEnd(test, result) {
    const bugs = test.annotations.filter((a) => a.type === "bug").map((a) => a.description);
    const shots = result.attachments.filter((a) => a.name === "screenshot" || /\.png$/.test(a.path || "")).map((a) => a.path).filter(Boolean);
    this.rows.push({
      title: test.title, file: path.basename(test.location.file), status: result.status, ms: result.duration,
      error: strip(result.error?.message).split("\n").slice(0, 14).join("\n"), bugs, shots,
      notes: test.annotations.filter((a) => a.type === "note").map((a) => a.description),
    });
  }
  onEnd() {
    const mark = (r) => (r.status === "passed" && !r.bugs.length ? "PASS" : r.status === "skipped" ? "SKIP" : r.bugs.length && r.status === "passed" ? "PASS (bugs seen)" : "FAIL");
    const lines = [
      "# keel daily-use e2e: summary", "",
      `Run: ${new Date().toISOString()} · keel ${process.env.KEEL_URL || "?"} · model: ${process.env.KEEL_E2E_REAL ? "REAL" : "fake"} · ${((Date.now() - this.t0) / 1000).toFixed(0)} s`,
      "", "| Journey | Result | Time |", "|---|---|---|",
      ...this.rows.map((r) => `| ${r.title} | ${mark(r)} | ${(r.ms / 1000).toFixed(1)} s |`),
      "", "## Findings", "",
    ];
    let n = 0;
    for (const r of this.rows) {
      for (const b of r.bugs) lines.push(`### ${++n}. ${r.title}`, "", "```", b, "```", "", ...r.shots.slice(-1).map((s) => `Screenshot: \`${path.relative(this.out, s)}\``), "");
      if (r.status === "failed" || r.status === "timedOut") {
        lines.push(`### ${++n}. ${r.title}: a check failed (keel bug or harness problem: read it)`, "", "```", r.error, "```", "", ...r.shots.slice(-1).map((s) => `Screenshot: \`${path.relative(this.out, s)}\``), "");
      }
    }
    if (!n) lines.push("No bug seen.", "");
    const notes = this.rows.filter((r) => r.notes.length);
    if (notes.length) lines.push("## Notes", "", ...notes.flatMap((r) => r.notes.map((x) => `- ${r.title}: ${x}`)), "");
    fs.mkdirSync(this.out, { recursive: true });
    fs.writeFileSync(path.join(this.out, "summary.md"), lines.join("\n"));
  }
}
