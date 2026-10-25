// keel 0.18.55: what an e2e test of the Database plugin found in its web part. Table names quoted for their database,
// a long schema that says it is cut, and a change of every row (or one statement of several) made plain before it runs.

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { App } from "../../../../web/src/App";
import { db, server } from "../../../../web/src/test/setup";
import { quoteTable, tableSelect } from "../dbModel";

const calls = (method: string, path: string) =>
  db.calls.filter((c) => c.method === method && c.path === path);

const local = {
  name: "local",
  kind: "postgres" as const,
  env: "local" as const,
  shown: "postgres://app:•••@localhost/app", // keel:allow-secret
  ok: true,
  server: "PostgreSQL 16.4",
  tables: 2,
  can_change: true,
};

describe("a table's name in the SQL keel writes", () => {
  it("is quoted for its database when it needs it", () => {
    expect(quoteTable("players", "postgres")).toBe("players");
    expect(quoteTable("Order Items", "postgres")).toBe('"Order Items"');
    expect(quoteTable("user", "postgres")).toBe('"user"');
    expect(quoteTable("Players", "postgres")).toBe('"Players"');
    expect(quoteTable("sales.orders", "postgres")).toBe("sales.orders");
    expect(quoteTable("Sales.my-orders", "postgres")).toBe(
      '"Sales"."my-orders"',
    );
    expect(quoteTable('say"hi', "sqlite")).toBe('"say""hi"');
    expect(quoteTable("order items", "mysql")).toBe("`order items`");
    expect(quoteTable("order", "mysql")).toBe("`order`");
    expect(quoteTable("Players", "mysql")).toBe("Players");
    expect(quoteTable("a`b", "mysql")).toBe("`a``b`");
    expect(tableSelect("order items", "mysql", 20)).toBe(
      "SELECT * FROM `order items` LIMIT 20",
    );
  });

  it("the table tab reads a table whose name needs quotes", async () => {
    const user = userEvent.setup();
    db.plugins.db = true;
    db.dbConns = [local];
    server.use(
      http.get("/api/projects/:pid/db/schema", () =>
        HttpResponse.json({ connection: "local", kind: "postgres", tables: [{ name: "Order Items", columns: [], fks: [] }] }),
      ),
    );
    location.hash = "#/repo";
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Database" }));
    const tree = await screen.findByRole("tree", { name: "Databases" });
    await user.click(within(tree).getByRole("button", { name: "Open local" }));
    await user.click(await within(tree).findByRole("button", { name: "Order Items" }));
    await waitFor(() =>
      expect(calls("POST", "/api/projects/ludus-engine/db/query").at(-1)?.body).toMatchObject({
        sql: 'SELECT * FROM "Order Items" LIMIT 100',
      }),
    );
  });
});

describe("a long schema", () => {
  it("says it shows 300 of N tables", async () => {
    const user = userEvent.setup();
    db.plugins.db = true;
    db.dbConns = [local];
    server.use(
      http.get("/api/projects/:pid/db/schema", () =>
        HttpResponse.json({
          connection: "local",
          kind: "postgres",
          truncated: true,
          total: 512,
          tables: [
            { name: "players", columns: [], fks: [] },
            { name: "scores", columns: [], fks: [] },
          ],
        }),
      ),
    );
    location.hash = "#/repo";
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Database" }));
    const tree = await screen.findByRole("tree", { name: "Databases" });
    await user.click(within(tree).getByRole("button", { name: "Open local" }));
    expect(
      await within(tree).findByText(/showing 2 of 512 tables/),
    ).toBeInTheDocument();
  });
});

describe("a change in the console", () => {
  async function openConsole() {
    const user = userEvent.setup();
    db.plugins.db = true;
    db.dbConns = [local];
    location.hash = "#/repo";
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Database" }));
    const tree = await screen.findByRole("tree", { name: "Databases" });
    await user.click(
      within(tree).getByRole("button", { name: "New console on local" }),
    );
    const box = await screen.findByLabelText("Console on local");
    return {
      user,
      box,
      sql: within(box).getByRole("textbox", { name: "SQL" }),
    };
  }

  it("that changes every row says so in red before it runs", async () => {
    server.use(
      http.post("/api/projects/:pid/db/query", async ({ request }) => {
        const b = (await request.json()) as { sql: string; confirm?: boolean };
        return HttpResponse.json({
          connection: "local",
          env: "local",
          kind: "change",
          sql: b.sql,
          changed: 7,
          done: !!b.confirm,
          every_row: true,
        });
      }),
    );
    const { user, box, sql } = await openConsole();
    await user.clear(sql);
    await user.type(sql, "update players set name = 'x'");
    await user.click(within(box).getByRole("button", { name: /Run/ }));
    const confirm = await within(box).findByRole("group", {
      name: "Change data",
    });
    expect(within(confirm).getByRole("alert")).toHaveTextContent(
      "No WHERE: this changes every row: 7 rows",
    );
  });

  it("with several statements runs and confirms only the one under the cursor, labeled", async () => {
    const { user, box, sql } = await openConsole();
    await user.clear(sql);
    await user.type(
      sql,
      "select 1;\nupdate players set name = 'x' where id = 1",
    );
    await user.click(within(box).getByRole("button", { name: /Run/ }));
    const confirm = await within(box).findByRole("group", {
      name: "Change data",
    });
    expect(
      within(confirm).getByText("Statement under the cursor:"),
    ).toBeInTheDocument();
    expect(
      within(confirm).getByText("update players set name = 'x' where id = 1"),
    ).toBeInTheDocument();
    expect(within(confirm).queryByRole("alert")).not.toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: /Run it/ }));
    await waitFor(() =>
      expect(
        calls("POST", "/api/projects/ludus-engine/db/query").at(-1)?.body,
      ).toMatchObject({
        sql: "update players set name = 'x' where id = 1",
        confirm: true,
      }),
    );
  });
});
