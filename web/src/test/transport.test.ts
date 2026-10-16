// The web client's transport: the web keeps "/api" on its own origin; keel TUI (cli/) points the same client at keel's
// address with Node's fetch and its own headers (docs/plans/keel-tui.md).
import { afterEach, describe, expect, it } from "vitest";
import { api, apiUrl, setTransport } from "../api";

afterEach(() => setTransport({ base: "", headers: {}, fetch: undefined }));

describe("transport", () => {
  it("is the page's own /api by default", () => {
    expect(apiUrl("/health")).toBe("/api/health");
    expect(api.eventsUrl("demo", true)).toBe("/api/events?project=demo&notify=all");
  });

  it("can send every request to another address, with extra headers and its own fetch", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    let n = 0;
    setTransport({
      base: "http://localhost:8099",
      headers: () => ({ "X-Keel-Via": "tui", "X-Keel-Tool": `/cmd${++n}` }),
      fetch: async (url, init) => {
        seen.push({ url: String(url), init });
        return new Response(JSON.stringify({ ok: true, engine: true, version: "x", fake: false }), { headers: { "content-type": "application/json" } });
      },
    });
    await api.health();
    await api.resume("t1", "approve");
    expect(seen.map((s) => s.url)).toEqual(["http://localhost:8099/api/health", "http://localhost:8099/api/threads/t1/resume"]);
    expect(seen[0].init?.headers).toEqual({ "X-Keel-Via": "tui", "X-Keel-Tool": "/cmd1" });
    expect(seen[1].init?.headers).toEqual({ "X-Keel-Via": "tui", "X-Keel-Tool": "/cmd2", "content-type": "application/json" });
    expect(api.eventsUrl(null, true)).toBe("http://localhost:8099/api/events?project=*");
  });
});
