// The Database plugin's DbConsole, split out of DbTool.tsx (DbTool.tsx re-exports what index.tsx and the tests use).

import { useEffect, useRef, useState } from "react";
import { ErrorBox, errorParts, Pill, useLoad } from "@keel/web-sdk";
import { dbApi, type DbConnection, type DbResult } from "./dbApi";
import { Icon } from "./icons";
import { EveryRow, ResultTable } from "./QueryPanel";
import { readStore, statementAt, statements, writeStore } from "./dbModel";

export function useRun(pid: string) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DbResult | null>(null);
  const [err, setErr] = useState<{ message: string; hint?: string } | null>(
    null,
  );
  const run = async (
    conn: DbConnection | undefined,
    sql: string,
    confirm = false,
  ) => {
    if (!conn || !sql.trim()) return null;
    setBusy(true);
    setErr(null);
    try {
      const r = await dbApi.query(pid, {
        connection: conn.name,
        sql,
        change: conn.can_change,
        confirm,
      });
      setResult(r);
      return r;
    } catch (e) {
      setResult(null);
      setErr(errorParts(e));
      return null;
    } finally {
      setBusy(false);
    }
  };
  const clear = () => {
    setResult(null);
    setErr(null);
  };
  return { busy, result, err, run, setResult, clear };
}

/** keel 0.18.55: with several statements in the console, which one ran (or waits for Run it). */
function Ran({ stmt, label }: { stmt: string; label: string }) {
  return (
    <p className="db-stmt">
      <span className="sub">{label}</span> <code className="mono">{stmt}</code>
    </p>
  );
}

function ChangeConfirm({
  r,
  busy,
  onRun,
  onCancel,
  stmt,
}: {
  r: DbResult;
  busy: boolean;
  onRun: () => void;
  onCancel: () => void;
  /** the statement under the cursor, shown when the console holds several */
  stmt?: string;
}) {
  if (r.kind !== "change") return null;
  if (r.done)
    return (
      <p className="qp-done" role="status">
        {r.changed} row{r.changed === 1 ? "" : "s"} changed in {r.connection}.
      </p>
    );
  return (
    <div className="qp-confirm" role="group" aria-label="Change data">
      {stmt && <Ran stmt={stmt} label="Statement under the cursor:" />}
      <span>
        This changes{" "}
        <b>
          {r.changed} row{r.changed === 1 ? "" : "s"}
        </b>{" "}
        in {r.connection} ({r.env}). keel ran it once and rolled it back to
        count.
      </span>
      <EveryRow r={r} />
      <button
        type="button"
        className="btn sm primary"
        disabled={busy}
        onClick={onRun}
      >
        Run it ({r.changed} rows)
      </button>
      <button type="button" className="btn sm ghost" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

export function ConsoleTab({
  pid,
  initial,
  onConn,
}: {
  pid: string;
  initial: string;
  onConn?: (conn: string) => void;
}) {
  const conns = useLoad(`db:${pid}`, () => dbApi.connections(pid), {
    live: false,
  });
  const [name, setName] = useState(initial);
  const conn = conns.data?.find((c) => c.name === name);
  const key = `keel2.db.console.${pid}.${name}`;
  const hkey = `keel2.db.history.${pid}.${name}`;
  const [sql, setSql] = useState(() => readStore(key, ""));
  const [history, setHistory] = useState<string[]>(() => {
    try {
      return JSON.parse(readStore(hkey, "[]"));
    } catch {
      return [];
    }
  });
  useEffect(() => {
    setSql(readStore(key, ""));
    try {
      setHistory(JSON.parse(readStore(hkey, "[]")));
    } catch {
      setHistory([]);
    }
  }, [key, hkey]);
  useEffect(() => {
    writeStore(key, sql);
  }, [key, sql]);
  const box = useRef<HTMLTextAreaElement>(null);
  const { busy, result, err, run, setResult, clear } = useRun(pid);
  const [last, setLast] = useState("");
  const several = statements(sql).length > 1;
  const go_ = async () => {
    const el = box.current;
    const stmt = statementAt(
      sql,
      el?.selectionStart ?? 0,
      el?.selectionEnd ?? 0,
    );
    setLast(stmt);
    const r = await run(conn, stmt);
    if (r) {
      const next = [stmt, ...history.filter((h) => h !== stmt)].slice(0, 20);
      setHistory(next);
      writeStore(hkey, JSON.stringify(next));
    }
  };
  return (
    <div className="db-console" aria-label={`Console on ${name}`}>
      <div className="db-bar">
        <Icon name="database" size={14} />
        <select
          aria-label="Database of this console"
          value={name}
          onChange={(e) => {
            // the text goes with the console (IntelliJ: a console's data source changes, its text stays)
            const next = e.target.value;
            writeStore(`keel2.db.console.${pid}.${next}`, sql);
            clear();
            if (onConn) onConn(next);
            else setName(next);
          }}
        >
          {(conns.data ?? [{ name } as DbConnection]).map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
              {c.env ? ` (${c.env})` : ""}
            </option>
          ))}
        </select>
        {conn && (
          <Pill tone={conn.can_change ? "run" : "warn"}>
            {conn.can_change ? "changes with your OK" : "read only"}
          </Pill>
        )}
        <button
          type="button"
          className="btn sm primary"
          disabled={busy || !sql.trim() || !conn}
          onClick={() => void go_()}
          title="Run the statement under the cursor, or the selection (⌘↵)"
        >
          <Icon name="play" size={12} /> {busy ? "Running…" : "Run"}
        </button>
        {history.length > 0 && (
          <select
            aria-label="History"
            value=""
            onChange={(e) => e.target.value && setSql(e.target.value)}
          >
            <option value="">History…</option>
            {history.map((h) => (
              <option key={h} value={h}>
                {h.replace(/\s+/g, " ").slice(0, 80)}
              </option>
            ))}
          </select>
        )}
      </div>
      <textarea
        ref={box}
        className="db-sql mono"
        aria-label="SQL"
        spellCheck={false}
        value={sql}
        placeholder={
          "SELECT * FROM players LIMIT 20;\n\n-- ⌘↵ runs the statement under the cursor, or the selection"
        }
        onChange={(e) => setSql(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void go_();
          }
        }}
      />
      <div className="db-out">
        {err && <ErrorBox error={err} />}
        {result && (
          <ChangeConfirm
            r={result}
            busy={busy}
            onRun={() => void run(conn, last, true)}
            onCancel={() => setResult(null)}
            stmt={several ? last : undefined}
          />
        )}
        {result?.kind === "read" && several && <Ran stmt={last} label="Ran the statement under the cursor:" />}
        {result?.kind === "read" && <ResultTable r={result} />}
        {!result && !err && <p className="sub">Results show here.</p>}
      </div>
    </div>
  );
}
