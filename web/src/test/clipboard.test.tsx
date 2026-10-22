// copyText works where navigator.clipboard is missing (plain http on a LAN) and says so when nothing works.

import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "../clipboard";

const setClipboard = (v: unknown) => Object.defineProperty(navigator, "clipboard", { value: v, configurable: true });

describe("copyText", () => {
  afterEach(() => { setClipboard(undefined); vi.restoreAllMocks(); });

  it("uses navigator.clipboard when there is one", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    expect(await copyText("abc")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("abc");
  });

  it("falls back to a hidden textarea and execCommand without navigator.clipboard", async () => {
    setClipboard(undefined);
    let selected = "";
    document.execCommand = vi.fn(() => { selected = (document.querySelector("textarea") as HTMLTextAreaElement).value; return true; });
    expect(await copyText("hello")).toBe(true);
    expect(selected).toBe("hello");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("falls back when writeText is refused, and reports false when the fallback fails too", async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error("denied")) });
    document.execCommand = vi.fn(() => false);
    expect(await copyText("x")).toBe(false);
    expect(document.execCommand).toHaveBeenCalledWith("copy");
  });
});
