// keel-tui --script: the real app driven through its own keyboard, with captures (what the real check uses).
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KeelCore } from "../src/core/keel";
import { runScript, stripAnsi } from "../src/script";
import { parseArgs } from "../src/main.args";
import { stubKeel } from "./stub";

describe("keel-tui --script", () => {
  it("types each line, presses keys, waits and saves captures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-tui-"));
    const file = join(dir, "run.txt");
    writeFileSync(file, ["# a run", "@snap start", "/workflows feature", "@snap workflows", "@key ctrl+f", "@snap rail", "/approve", "@snap approved"].join("\n"));
    const stub = stubKeel();
    const core = new KeelCore({ url: "http://keel.test", fetch: stub.fetch, noLive: true });
    const logs: string[] = [];
    const code = await runScript(core, file, { out: join(dir, "out"), width: 100, log: (s) => logs.push(s) });
    expect(code).toBe(0);
    const read = (n: string) => readFileSync(join(dir, "out", `${n}.txt`), "utf8");
    expect(read("start")).toContain("keel v2 0.17.3");
    expect(read("workflows")).toContain("DIAGRAM workflow feature w=98");
    expect(read("rail")).toContain("Flow · feature");
    expect(read("approved")).toContain("✓ approved spec approval");
    expect(existsSync(join(dir, "out", "error-1.txt"))).toBe(false);
    expect(read("approved")).not.toMatch(/\x1b\[/);
  });

  it("strips colours and cursor moves", () => {
    expect(stripAnsi("\x1b[1mkeel\x1b[22m \x1b[2K\x1b[1Av2")).toBe("keel v2");
  });
});

describe("arguments", () => {
  it("reads options and the environment", () => {
    expect(parseArgs(["-c", "/status", "-c", "/next", "--project", "demo"], { KEEL_URL: "http://localhost:8099" })).toMatchObject({
      url: "http://localhost:8099", project: "demo", commands: ["/status", "/next"], width: 100 });
    expect(parseArgs(["--help"], {})).toBe("help");
    expect(() => parseArgs(["--nope"], {})).toThrow("unknown option --nope");
  });
});
