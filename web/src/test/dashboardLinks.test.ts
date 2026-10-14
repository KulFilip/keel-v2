// v0.15.8 keel_dashboard links (#/projects/<id>/<page>) and the "started via MCP" timeline line.
import { describe, expect, it } from "vitest";
import { eventLine } from "../components/events";
import { parseHash } from "../routes";
import type { EngineEvent } from "../api";

describe("dashboard links", () => {
  it("a link that names its project opens that project's page", () => {
    expect(parseHash("#/projects/shop/flow")).toEqual({ page: "flow", arg: undefined, project: "shop" });
    expect(parseHash("#/projects/shop/map/er")).toEqual({ page: "map", arg: "er", project: "shop" });
    expect(parseHash("#/projects/my%20app/map/system")).toEqual({ page: "map", arg: "system", project: "my app" });
  });

  it("the All projects page still works", () => {
    expect(parseHash("#/projects")).toEqual({ page: "projects", arg: undefined });
  });
});

describe("timeline", () => {
  const started = (data: Record<string, unknown>) =>
    ({ type: "thread.started", thread_id: "t", project_id: "p", at: "2026-10-14T10:00:00Z", data }) as unknown as EngineEvent;

  it("says when a flow was started via MCP", () => {
    expect(eventLine(started({ via: "mcp" })).text).toBe("flow started via MCP");
    expect(eventLine(started({})).text).toBe("flow started");
  });
});
