// The Database plugin's DbTableTab, split out of DbTool.tsx (DbTool.tsx re-exports what index.tsx and the tests use).

import { useEffect, useMemo, useState } from "react";
import { ErrorBox, useLoad } from "@keel/web-sdk";
import { dbApi } from "./dbApi";
import { Icon } from "./icons";
import { ResultTable } from "./QueryPanel";
import { useRun } from "./DbConsole";

export function TableTab({
  pid,
  conn,
  table,
}: {
  pid: string;
  conn: string;
  table: string;
}) {
  const conns = useLoad(`db:${pid}`, () => dbApi.connections(pid), {
    live: false,
  });
  const schema = useLoad(
    `db-schema:${pid}:${conn}`,
    () => dbApi.schema(pid, conn),
    { live: false },
  );
  const c = conns.data?.find((x) => x.name === conn);
  const t = schema.data?.tables.find((x) => x.name === table);
  const [view, setView] = useState<"data" | "structure">("data");
  const [where, setWhere] = useState("");
  const { busy, result, err, run } = useRun(pid);
  const sql = useMemo(
    () =>
      `SELECT * FROM ${table}${where.trim() ? ` WHERE ${where.trim()}` : ""} LIMIT 100`,
    [table, where],
  );
  useEffect(() => {
    if (c) void run(c, sql);
  }, [c?.name, table]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="db-console" aria-label={`${table} in ${conn}`}>
      <div className="db-bar">
        <Icon name="table" size={14} />
        <b>{table}</b>
        <span className="sub">· {conn}</span>
        <div className="db-views" role="tablist" aria-label="Table view">
          <button
            type="button"
            role="tab"
            aria-selected={view === "data"}
            className={view === "data" ? "on" : ""}
            onClick={() => setView("data")}
          >
            Data
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "structure"}
            className={view === "structure" ? "on" : ""}
            onClick={() => setView("structure")}
          >
            Structure
          </button>
        </div>
      </div>
      {view === "data" ? (
        <>
          <form
            className="db-where"
            onSubmit={(e) => {
              e.preventDefault();
              void run(c, sql);
            }}
          >
            <span className="mono sub">WHERE</span>
            <input
              className="inline-input mono"
              aria-label="Filter rows"
              value={where}
              placeholder="value > 100"
              onChange={(e) => setWhere(e.target.value)}
            />
            <button type="submit" className="btn sm" disabled={busy || !c}>
              {busy ? "Reading…" : "Apply"}
            </button>
          </form>
          <div className="db-out">
            {err && <ErrorBox error={err} />}
            {result?.kind === "read" && <ResultTable r={result} />}
          </div>
        </>
      ) : !t ? (
        <p className="sub db-out">Reading the structure…</p>
      ) : (
        <div className="db-out">
          <div className="table-wrap">
            <table aria-label={`Structure of ${table}`}>
              <thead>
                <tr>
                  <th>Column</th>
                  <th>Type</th>
                  <th>Null</th>
                  <th>Key</th>
                </tr>
              </thead>
              <tbody>
                {t.columns.map((col) => {
                  const fk = t.fks.find((f) => f.column === col.name);
                  return (
                    <tr key={col.name}>
                      <td className="mono">{col.name}</td>
                      <td className="mono">{col.type}</td>
                      <td>{col.nullable ? "yes" : "no"}</td>
                      <td>
                        {col.pk
                          ? "primary key"
                          : fk
                            ? `→ ${fk.table}.${fk.ref}`
                            : ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
