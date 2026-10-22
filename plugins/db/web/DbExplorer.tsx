// The Database plugin's DbExplorer, split out of DbTool.tsx (DbTool.tsx re-exports what index.tsx and the tests use).

import { useState } from "react";
import { ErrorBox, go, useLoad } from "@keel/web-sdk";
import { dbApi, type DbConnection, type LiveTable } from "./dbApi";
import { Icon } from "./icons";
import { KIND } from "./dbModel";

// ------------------------------------------------------------------ the side bar: data sources ▸ tables ▸ columns

export function DbExplorer({
  pid,
  onConsole,
  onTable,
}: {
  pid: string;
  onConsole: (conn: string) => void;
  onTable: (conn: string, table: string, pin: boolean) => void;
}) {
  const conns = useLoad(`db:${pid}`, () => dbApi.connections(pid), {
    live: false,
  });
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [find, setFind] = useState("");
  return (
    <div className="sv db-sv">
      <div className="sv-head">
        <h2 className="sv-title">Database</h2>
        <div className="sv-tools">
          <button
            type="button"
            className="sv-tool"
            title="Add a database (Connections › Databases)"
            aria-label="Add a database"
            onClick={() => go("connections")}
          >
            <Icon name="plus" size={15} />
          </button>
          <button
            type="button"
            className="sv-tool"
            title="Refresh"
            aria-label="Refresh the databases"
            onClick={() => void conns.reload()}
          >
            <Icon name="refresh" size={15} />
          </button>
        </div>
      </div>
      <div className="sv-pad">
        <input
          type="search"
          className="inline-input db-find"
          placeholder="Find a table"
          aria-label="Find a table"
          value={find}
          onChange={(e) => setFind(e.target.value)}
        />
      </div>
      {conns.error && (
        <div className="sv-pad">
          <ErrorBox error={conns.error} />
        </div>
      )}
      {conns.data && !conns.data.length && (
        <p className="sv-pad sub">
          No database yet.{" "}
          <button
            type="button"
            className="btn sm"
            onClick={() => go("connections")}
          >
            Add one
          </button>
        </p>
      )}
      <ul className="db-tree" role="tree" aria-label="Databases">
        {(conns.data ?? []).map((c) => (
          <ConnNode
            key={c.name}
            pid={pid}
            c={c}
            open={!!open[c.name] || !!find.trim()}
            find={find.trim().toLowerCase()}
            onToggle={() => setOpen((o) => ({ ...o, [c.name]: !o[c.name] }))}
            onConsole={() => onConsole(c.name)}
            onTable={(t, pin) => onTable(c.name, t, pin)}
          />
        ))}
      </ul>
    </div>
  );
}

function ConnNode({
  pid,
  c,
  open,
  find,
  onToggle,
  onConsole,
  onTable,
}: {
  pid: string;
  c: DbConnection;
  open: boolean;
  find: string;
  onToggle: () => void;
  onConsole: () => void;
  onTable: (t: string, pin: boolean) => void;
}) {
  const schema = useLoad(
    open ? `db-schema:${pid}:${c.name}` : null,
    () => dbApi.schema(pid, c.name),
    { live: false },
  );
  const [tableOpen, setTableOpen] = useState<Record<string, boolean>>({});
  const tables = (schema.data?.tables ?? []).filter(
    (t) => !find || t.name.toLowerCase().includes(find),
  );
  return (
    <li role="treeitem" aria-expanded={open} aria-label={`Database ${c.name}`}>
      <div className="db-row db-conn">
        <button
          type="button"
          className="db-twist"
          onClick={onToggle}
          aria-label={open ? `Close ${c.name}` : `Open ${c.name}`}
        >
          {open ? "▾" : "▸"}
        </button>
        <span
          className={`db-dot ${c.ok === true ? "ok" : c.ok === false ? "bad" : ""}`}
          aria-hidden="true"
        />
        <Icon name="database" size={14} />
        <button
          type="button"
          className="db-name"
          onDoubleClick={onConsole}
          onClick={onToggle}
        >
          {c.name}
        </button>
        <span
          className={`db-env ${c.can_change ? "rw" : "ro"}`}
          title={
            c.can_change ? "changes of data with your OK" : "read only, always"
          }
        >
          {c.env}
        </span>
        <button
          type="button"
          className="db-act"
          title={`New console on ${c.name}`}
          aria-label={`New console on ${c.name}`}
          onClick={onConsole}
        >
          <Icon name="console" size={14} />
        </button>
      </div>
      {open && (
        <ul role="group">
          {schema.error && (
            <li className="db-row db-err-row">{schema.error.message}</li>
          )}
          {!schema.data && !schema.error && (
            <li className="db-row sub">reading the tables…</li>
          )}
          {schema.data && (
            <li className="db-row db-meta sub">
              {KIND[c.kind] ?? c.kind}
              {c.server ? ` · ${c.server}` : ""} · {schema.data.tables.length}{" "}
              tables
            </li>
          )}
          {tables.map((t) => (
            <TableNode
              key={t.name}
              t={t}
              open={!!tableOpen[t.name]}
              onToggle={() =>
                setTableOpen((o) => ({ ...o, [t.name]: !o[t.name] }))
              }
              onOpen={(pin) => onTable(t.name, pin)}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function TableNode({
  t,
  open,
  onToggle,
  onOpen,
}: {
  t: LiveTable;
  open: boolean;
  onToggle: () => void;
  onOpen: (pin: boolean) => void;
}) {
  const fkOf = (col: string) => t.fks.find((f) => f.column === col);
  return (
    <li role="treeitem" aria-expanded={open} aria-label={`Table ${t.name}`}>
      <div className="db-row db-table">
        <button
          type="button"
          className="db-twist"
          onClick={onToggle}
          aria-label={open ? `Close ${t.name}` : `Columns of ${t.name}`}
        >
          {open ? "▾" : "▸"}
        </button>
        <Icon name="table" size={14} />
        <button
          type="button"
          className="db-name"
          onClick={() => onOpen(false)}
          onDoubleClick={() => onOpen(true)}
          title="Open its data (double-click keeps the tab)"
        >
          {t.name}
        </button>
        <span className="sub db-count">{t.columns.length}</span>
      </div>
      {open && (
        <ul role="group">
          {t.columns.map((c) => {
            const fk = fkOf(c.name);
            return (
              <li
                key={c.name}
                className="db-row db-col"
                role="treeitem"
                aria-label={`Column ${c.name}`}
              >
                {c.pk ? (
                  <span className="db-key" title="primary key">
                    <Icon name="key" size={13} />
                  </span>
                ) : (
                  <span className="db-key">
                    <Icon name="column" size={13} />
                  </span>
                )}
                <span className={c.pk ? "db-pk" : undefined}>{c.name}</span>
                <span className="sub db-type">
                  {c.type}
                  {c.nullable ? "" : " · not null"}
                </span>
                {fk && (
                  <span
                    className="db-fk"
                    title={`foreign key to ${fk.table}.${fk.ref}`}
                  >
                    → {fk.table}.{fk.ref}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

// ------------------------------------------------------------------ the editor tab: a console or a table
