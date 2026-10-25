// keel 0.18.54 the picker reads as a list: a number per option, its description on its own line, air between options
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Picker } from "../src/ui/parts";
import { ThemeProvider } from "../src/ui/theme";
import { makeTheme } from "../src/core/theme";
import { stripAnsi } from "../src/script";

const color = makeTheme({ KEEL_TUI_THEME: "dark" }, 3);
const choices = [
  { label: "Add one small real file to each package now (recommended)", value: "a", hint: "e.g. a value type with no logic, just to give the guard something to check; small, keeps AC-5's test exactly as planned" },
  { label: "Loosen the guard in the AC-5 test", value: "b", hint: "drop the 'assert all_files' check so an empty package passes; weakens the guarantee the spec wanted" },
  { label: "Leave it stopped for now", value: "c", hint: "no code changes; decide later" },
  { label: "Other… (my own words)", value: "o" },
];
const frame = (el: React.ReactElement) => {
  const r = render(<ThemeProvider theme={color}>{el}</ThemeProvider>);
  const out = stripAnsi(r.lastFrame() ?? "");
  r.unmount();
  return out;
};

describe("the picker's layout", () => {
  it("numbers each option, puts its description on its own indented line and a blank line between options", () => {
    const out = frame(<Picker title="How should AC-5's empty package be handled?" choices={choices} index={0} filter="" />);
    if (process.env.SHOW) console.log("\n" + out);
    const lines = out.split("\n").map((l) => l.replace(/^│ ?|│$/g, "").trimEnd());
    const at = (s: string) => lines.findIndex((l) => l.includes(s));
    expect(lines[at("Add one small")]).toMatch(/❯ 1\. Add one small real file/);
    expect(lines[at("Loosen the guard")]).toMatch(/^ {2}2\. Loosen the guard/);
    expect(lines[at("Other…")]).toMatch(/^ {2}4\. Other…/);
    // the description starts under the label, not under the number
    const label = lines[at("Loosen the guard")].indexOf("Loosen");
    expect(lines[at("drop the")].indexOf("drop the")).toBe(label);
    // air between options
    expect(lines[at("Loosen the guard") - 1].trim()).toBe("");
    expect(out).toContain("1–4 picks · ↑↓ · Enter · type to filter · Esc");
  });

  it("a long description wraps under itself", () => {
    const out = frame(<Picker title="Pick one" choices={choices} index={1} filter="" />);
    const lines = out.split("\n").map((l) => l.replace(/^│ ?|│$/g, "").trimEnd());
    const first = lines.findIndex((l) => l.includes("e.g. a value type"));
    const col = lines[first].indexOf("e.g.");
    expect(lines[first + 1].slice(0, col).trim()).toBe("");
    expect(lines[first + 1].trim().length).toBeGreaterThan(0);
  });

  it("no numbers while a filter is typed (digits then filter); short lists without descriptions stay compact", () => {
    const filtered = frame(<Picker title="Pick one" choices={choices.slice(0, 2)} index={0} filter="lo" />);
    expect(filtered).not.toMatch(/\d\. Add/);
    const yesNo = frame(<Picker title="Run anyway?" choices={[{ label: "Yes", value: "y" }, { label: "No", value: "n" }]} index={0} filter="" />);
    const l = yesNo.split("\n");
    expect(l[l.findIndex((x) => x.includes("1. Yes")) + 1]).toContain("2. No");
  });
});
