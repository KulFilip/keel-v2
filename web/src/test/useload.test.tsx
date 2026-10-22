import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppProvider, useLoad } from "../state";

describe("useLoad", () => {
  it("an older, slower answer never overwrites a newer one for the same key", async () => {
    const resolvers: ((v: string) => void)[] = [];
    let reload: () => Promise<void> = async () => {};
    function Probe() {
      const r = useLoad<string>("k", () => new Promise<string>((res) => resolvers.push(res)), { live: false });
      reload = r.reload;
      return <div data-testid="v">{r.data ?? "none"}</div>;
    }
    render(<AppProvider><Probe /></AppProvider>);
    await act(async () => { await Promise.resolve(); });
    expect(resolvers).toHaveLength(1);                 // the first load (slow)
    let second!: Promise<void>;
    act(() => { second = reload(); });
    expect(resolvers).toHaveLength(2);                 // the second load (fast)
    await act(async () => { resolvers[1]("new"); await second; });
    expect(screen.getByTestId("v")).toHaveTextContent("new");
    await act(async () => { resolvers[0]("old"); await Promise.resolve(); });
    expect(screen.getByTestId("v")).toHaveTextContent("new");
  });
});
