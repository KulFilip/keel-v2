// What a page keeps in the browser (src/storage.ts, in @keel/web-sdk): read back after an unmount, a stale or broken
// value gives the default, blocked storage never throws, an empty draft keeps no key, drafts are capped, and a scroll
// position comes back once the data is there.

import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { capStored, readStored, useDraft, useStored, useStoredScroll, writeStored } from "../sdk";

afterEach(() => vi.restoreAllMocks());

describe("readStored / writeStored", () => {
  it("reads what was written, and the fallback for nothing, bad JSON or a value that is not valid", () => {
    writeStored("k.a", { n: 1 });
    expect(readStored("k.a", null)).toEqual({ n: 1 });
    expect(readStored("k.none", "x")).toBe("x");
    sessionStorage.setItem("k.bad", "{oops");
    expect(readStored("k.bad", "x")).toBe("x");
    writeStored("k.f", "gone");
    expect(readStored("k.f", "all", "session", (v) => v === "all" || v === "open")).toBe("all");
    writeStored("k.l", 3, "local");
    expect(readStored("k.l", 0, "local")).toBe(3);
    expect(readStored("k.l", 0, "session")).toBe(0);
  });

  it("never throws when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    expect(() => writeStored("k", 1)).not.toThrow();
    expect(readStored("k", 7)).toBe(7);
    const { result } = renderHook(() => useStored("k", "a"));
    expect(result.current[0]).toBe("a");
    act(() => result.current[1]("b"));
    expect(result.current[0]).toBe("b");
  });
});

describe("useStored", () => {
  it("comes back after an unmount, and follows its key", () => {
    const first = renderHook(() => useStored("v.tab.p1", "changes"));
    act(() => first.result.current[1]("threads"));
    first.unmount();
    const again = renderHook(({ k }) => useStored(k, "changes"), { initialProps: { k: "v.tab.p1" } });
    expect(again.result.current[0]).toBe("threads");
    again.rerender({ k: "v.tab.p2" });
    expect(again.result.current[0]).toBe("changes");
    act(() => again.result.current[1]((t) => `${t}!`));
    expect(again.result.current[0]).toBe("changes!");
    expect(readStored("v.tab.p1", "")).toBe("threads");
  });
});

describe("useDraft", () => {
  it("keeps text in localStorage, and an empty text keeps no key", () => {
    const a = renderHook(() => useDraft("d.p.r1"));
    act(() => a.result.current[1]("half a reply"));
    a.unmount();
    const b = renderHook(() => useDraft("d.p.r1"));
    expect(b.result.current[0]).toBe("half a reply");
    act(() => b.result.current[1](""));
    expect(localStorage.getItem("d.p.r1")).toBeNull();
    act(() => b.result.current[1]("again"));
    act(() => b.result.current[2]());
    expect(localStorage.getItem("d.p.r1")).toBeNull();
  });

  it("keeps at most the cap: the oldest drafts go first", () => {
    for (let i = 0; i < 5; i++) writeStored(`d.q.${i}`, { text: `t${i}`, at: 100 + i }, "local");
    writeStored("other", { text: "x", at: 1 }, "local");
    capStored("d.q.", 3);
    expect(Object.keys(localStorage).filter((k) => k.startsWith("d.q.")).sort()).toEqual(["d.q.2", "d.q.3", "d.q.4"]);
    expect(localStorage.getItem("other")).not.toBeNull();
    const h = renderHook(() => useDraft("d.q.new", { capPrefix: "d.q.", cap: 3 }));
    act(() => h.result.current[1]("newest"));
    expect(Object.keys(localStorage).filter((k) => k.startsWith("d.q.")).sort()).toEqual(["d.q.3", "d.q.4", "d.q.new"]);
  });
});

describe("useStoredScroll", () => {
  function Box({ ready }: { ready: boolean }) {
    const ref = useStoredScroll<HTMLDivElement>("s.box", ready);
    return <div ref={ref} data-testid="box" />;
  }

  it("restores the scroll position once the data is there", () => {
    writeStored("s.box", 240);
    const { rerender } = render(<Box ready={false} />);
    expect(screen.getByTestId("box").scrollTop).toBe(0);
    rerender(<Box ready />);
    expect(screen.getByTestId("box").scrollTop).toBe(240);
  });

  it("saves where you scrolled to, also when the box goes right after", () => {
    const { unmount } = render(<Box ready />);
    const box = screen.getByTestId("box");
    box.scrollTop = 90;
    box.dispatchEvent(new Event("scroll"));
    unmount();
    expect(readStored("s.box", 0)).toBe(90);
  });
});

describe("useStored in two places", () => {
  it("shows a write in one at once in the other (same store and key), and not in another key", () => {
    const a = renderHook(() => useStored<string[]>("live.k", [], { store: "local" }));
    const b = renderHook(() => useStored<string[]>("live.k", [], { store: "local" }));
    const other = renderHook(() => useStored<string[]>("live.other", [], { store: "local" }));
    act(() => a.result.current[1]((h) => [...h, "x"]));
    expect(b.result.current[0]).toEqual(["x"]);
    act(() => b.result.current[1]((h) => [...h, "y"]));
    expect(a.result.current[0]).toEqual(["x", "y"]);
    expect(other.result.current[0]).toEqual([]);
    // another browser tab's write comes in through the storage event
    localStorage.setItem("live.k", JSON.stringify(["z"]));
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "live.k" }));
    });
    expect(a.result.current[0]).toEqual(["z"]);
  });
});
