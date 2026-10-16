// keel TUI 0.18.8: Alt+Tab (Escape, Tab) or Shift+Tab switches KeelBot's mode; the status line always shows it.
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { App, type Probe } from "../src/ui/App";
import { KeelCore } from "../src/core/keel";
import { makeTheme } from "../src/core/theme";
import { stripAnsi } from "../src/script";
import { stubKeel, tick, waitFor } from "./stub";

const none = makeTheme({ NO_COLOR: "1" }, 0);

describe("KeelBot's mode from the keyboard", () => {
  it("Alt+Tab and Shift+Tab go ask → edit → fix (a gate waits) → side → ask, and the status line says which", async () => {
    const stub = stubKeel();
    const core = new KeelCore({ url: "http://keel.test", fetch: stub.fetch, noLive: true, cwd: "/work/demo" });
    const probe: Probe = { started: false, busy: false, pick: false, ask: false, chatBusy: false, answers: 0 };
    const r = render(<App core={core} probe={probe} width={140} theme={none} />);
    const frame = () => stripAnsi(r.lastFrame() ?? "");
    await waitFor(() => probe.started);
    expect(frame()).toContain("💬 ask · demo");                      // the mode is the status line's first word
    const seen: string[] = [];
    for (const k of ["\x1b\t", "\x1b[Z", "\x1b\t", "\x1b[Z"]) {
      r.stdin.write(k);
      await tick(50);
      seen.push(core.snapshot.chat.mode);
    }
    expect(seen).toEqual(["edit", "fix", "side", "ask"]);          // the stub's flow waits at a gate: fix is in the turn
    expect(frame()).not.toContain("KeelBot: ");                     // a switch writes nothing into the transcript
    r.stdin.write("\x1b\t");
    await tick(50);
    expect(frame()).toContain("📝 edit · demo");
    expect(frame()).not.toContain("\t");                            // never typed into the prompt
    r.unmount();
  });
});
