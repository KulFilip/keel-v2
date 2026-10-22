import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { http, HttpResponse } from "msw";
import { db, FakeEventSource, server } from "./setup";

let lists = 0;
const projectLists = () => lists;

describe("the event stream", () => {
  it("reloads the projects when it opens again after a drop (not only the first time)", async () => {
    lists = 0;
    server.use(http.get("/api/projects", () => { lists++; return HttpResponse.json(db.projects); }));
    location.hash = "#/flow";
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("live")).toHaveTextContent("Live"));
    const before = projectLists();
    const n = FakeEventSource.instances.length;
    act(() => FakeEventSource.instances.filter((s) => !s.closed).at(-1)!.onerror?.(new Event("error")));
    // the first retry waits about 1 s, then the new connection opens
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(n), { timeout: 3000 });
    await waitFor(() => expect(screen.getByTestId("live")).toHaveTextContent("Live"));
    await waitFor(() => expect(projectLists()).toBeGreaterThan(before));
  });
});
