// keel 0.18.57 the overview's Database and System tabs: what a change does to the database (before -> after, per table,
// the migrations in plain words, the risks keel sees, the files it could not read) and the parts of the system it
// touches. Read from git by the engine with no model (GET /review/diagrams). Each diagram is Mermaid, drawn here with
// keel's Mermaid renderer (its own chunk, loaded on the first tab that needs it), and ASCII: the Text view, the
// fallback when Mermaid cannot draw it, and what keel TUI shows. Both copy as they are, for a pull request's text.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  copyText,
  ErrorBox,
  pageIsDark,
  Pill,
  renderMermaid,
  useNarrow,
  type PillTone,
} from "@keel/web-sdk";
import { reloadDiagrams, useDiagrams } from "./diagramStore";
import type { DatabaseDiagram, DbTable, ReviewView, SystemDiagram } from "./reviewApi";

type Mode = "diagram" | "text" | "list";

/** keel's Mermaid renderer and its copy, as one object (the tests put stand-ins here; jsdom cannot lay out an SVG). */
export const draw = { mermaid: renderMermaid, copy: copyText };

const STATUS_WORD: Record<string, string> = {
  new: "new",
  added: "new",
  changed: "changed",
  removed: "removed",
  related: "related",
};
const MARK: Record<string, string> = {
  new: "+",
  added: "+",
  changed: "~",
  removed: "−",
  same: "",
  related: "",
};
const RISK_TONE: Record<string, PillTone> = {
  high: "bad",
  medium: "warn",
  low: "idle",
};

/** The page's light or dark, live (keel's theme switch sets data-theme; else the system's). */
function useDark(): boolean {
  const [dark, setDark] = useState(pageIsDark);
  useEffect(() => {
    const on = () => setDark(pageIsDark());
    const obs = new MutationObserver(on);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const m = window.matchMedia?.("(prefers-color-scheme: dark)");
    m?.addEventListener?.("change", on);
    return () => {
      obs.disconnect();
      m?.removeEventListener?.("change", on);
    };
  }, []);
  return dark;
}

function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function svgSize(svg: string): { w: number; h: number } {
  const m = /viewBox="[\d.-]+ [\d.-]+ ([\d.]+) ([\d.]+)"/.exec(svg);
  return m
    ? { w: Math.ceil(Number(m[1])), h: Math.ceil(Number(m[2])) }
    : { w: 800, h: 600 };
}

async function toPng(svg: string, dark: boolean): Promise<Blob> {
  const { w, h } = svgSize(svg);
  const scale = 2;
  const img = new Image();
  const sized = svg.replace(/<svg\b/, `<svg width="${w}" height="${h}"`);
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(sized);
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = w * scale;
  canvas.height = h * scale;
  const g = canvas.getContext("2d");
  if (!g) throw new Error("no canvas");
  g.fillStyle = dark ? "#1e1f22" : "#ffffff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.scale(scale, scale);
  g.drawImage(img, 0, 0, w, h);
  return new Promise((ok, bad) =>
    canvas.toBlob((b) => (b ? ok(b) : bad(new Error("no PNG"))), "image/png"),
  );
}

/**
 * One diagram: Mermaid drawn as SVG (zoom, scroll inside its box, full screen), the ASCII text, or a list (the phone's
 * view). Copy Mermaid / Copy ASCII, and Save as SVG / PNG. When Mermaid cannot draw it, the text shows instead.
 */
export function DiagramBox({
  name,
  title,
  mermaid,
  ascii,
  list,
}: {
  name: string;
  title: string;
  mermaid: string;
  ascii: string;
  list: ReactNode;
}) {
  const narrow = useNarrow(560);
  const dark = useDark();
  const [mode, setMode] = useState<Mode>(narrow ? "list" : "diagram");
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [full, setFull] = useState(false);
  const [said, setSaid] = useState("");
  const inner = useRef<HTMLDivElement>(null);
  const natural = useMemo(() => (svg ? svgSize(svg) : null), [svg]);

  useEffect(() => {
    if (mode !== "diagram" || !mermaid) return;
    let live = true;
    setFailed(null);
    draw
      .mermaid(mermaid, { dark })
      .then((s) => live && setSvg(s))
      .catch((e: unknown) => {
        if (!live) return;
        setSvg(null);
        setFailed(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [mermaid, dark, mode]);

  // the SVG keeps its own size: fit to the box, or its natural size times the zoom
  useEffect(() => {
    const el = inner.current?.querySelector("svg");
    if (!el || !natural) return;
    el.style.maxWidth = "none";
    el.style.height = "auto";
    el.setAttribute(
      "width",
      zoom === "fit" ? "100%" : String(Math.round(natural.w * zoom)),
    );
    el.removeAttribute("height");
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", title);
  }, [svg, zoom, natural, title, full, mode]);

  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFull(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);

  const say = (s: string) => {
    setSaid(s);
    setTimeout(() => setSaid(""), 2000);
  };
  const copy = async (what: "Mermaid" | "ASCII") => {
    const text =
      what === "Mermaid"
        ? "```mermaid\n" + mermaid + "```\n"
        : "```\n" + ascii + "\n```\n";
    say((await draw.copy(text)) ? `${what} copied` : "Copy failed");
  };
  const step = (k: number) => {
    const cur =
      zoom === "fit"
        ? inner.current && natural
          ? inner.current.clientWidth / natural.w
          : 1
        : zoom;
    setZoom(Math.min(4, Math.max(0.25, Math.round(cur * k * 100) / 100)));
  };
  const showText = mode === "text" || (mode === "diagram" && !!failed);

  return (
    <div
      className={`rv-dgm${full ? " full" : ""}`}
      role={full ? "dialog" : "group"}
      aria-label={title}
      aria-modal={full || undefined}
    >
      <div className="rv-dgm-bar">
        <div className="rv-seg" role="radiogroup" aria-label={`${title}: view`}>
          {(["diagram", "text", "list"] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              className={mode === m ? "on" : ""}
              onClick={() => setMode(m)}
            >
              {m === "diagram" ? "Diagram" : m === "text" ? "Text" : "List"}
            </button>
          ))}
        </div>
        {mode === "diagram" && svg && !failed && (
          <span className="rv-row" role="group" aria-label="Zoom">
            <button
              type="button"
              className="btn sm"
              aria-label="Zoom out"
              onClick={() => step(1 / 1.25)}
            >
              −
            </button>
            <button
              type="button"
              className="btn sm"
              aria-label="Zoom in"
              onClick={() => step(1.25)}
            >
              +
            </button>
            <button
              type="button"
              className="btn sm"
              aria-label="Fit to the box"
              disabled={zoom === "fit"}
              onClick={() => setZoom("fit")}
            >
              Fit
            </button>
          </span>
        )}
        <span className="rv-dgm-sp" />
        <button
          type="button"
          className="btn sm"
          onClick={() => void copy("Mermaid")}
          title="Mermaid, for a pull request's description"
        >
          Copy Mermaid
        </button>
        <button
          type="button"
          className="btn sm"
          onClick={() => void copy("ASCII")}
        >
          Copy ASCII
        </button>
        <button
          type="button"
          className="btn sm"
          aria-label={`Save ${title} as SVG`}
          disabled={!svg}
          onClick={() =>
            svg &&
            download(`${name}.svg`, new Blob([svg], { type: "image/svg+xml" }))
          }
        >
          SVG
        </button>
        <button
          type="button"
          className="btn sm"
          aria-label={`Save ${title} as PNG`}
          disabled={!svg}
          onClick={() =>
            svg &&
            void toPng(svg, dark)
              .then((b) => download(`${name}.png`, b))
              .catch(() => say("PNG failed"))
          }
        >
          PNG
        </button>
        <button
          type="button"
          className="btn sm"
          aria-label={full ? "Close full screen" : "Full screen"}
          aria-pressed={full}
          onClick={() => setFull(!full)}
        >
          {full ? "Close" : "⤢"}
        </button>
        <span className="rv-dim" aria-live="polite">
          {said}
        </span>
      </div>
      {mode === "diagram" && failed && (
        <p className="rv-dim" role="note">
          Mermaid could not draw this one, so here is the same picture as text.
        </p>
      )}
      {mode === "diagram" && !svg && !failed && (
        <div className="rv-dim pg-spin" role="status">
          Drawing…
        </div>
      )}
      {mode === "diagram" && svg && !failed && (
        <div
          className="rv-dgm-box"
          tabIndex={0}
          aria-label={`${title} (scrolls)`}
        >
          {/* the SVG comes from keel's Mermaid at its strict level, from keel's own text */}
          <div
            ref={inner}
            className="rv-dgm-svg"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      )}
      {showText && (
        <pre
          className="rv-diagram rv-dgm-text"
          tabIndex={0}
          aria-label={`${title} as text`}
        >
          {ascii}
        </pre>
      )}
      {mode === "list" && <div className="rv-dgm-list">{list}</div>}
    </div>
  );
}

function OpenLink({
  path,
  line,
  onOpen,
  files,
}: {
  path: string;
  line?: number | null;
  onOpen: (path: string, line?: number | null) => void;
  files: Set<string>;
}) {
  const label = line ? `${path}:${line}` : path;
  if (!files.has(path)) return <span className="mono">{label}</span>;
  return (
    <button
      type="button"
      className="rv-link mono"
      onClick={() => onOpen(path, line)}
    >
      {label}
    </button>
  );
}

function TableList({ tables }: { tables: DbTable[] }) {
  return (
    <ul className="rv-list rv-tlist">
      {tables.map((t) => (
        <li key={t.name} className={`rv-st-${t.status}`}>
          <b className="mono">
            {MARK[t.status]} {t.name}
          </b>{" "}
          <span className="rv-dim">
            {STATUS_WORD[t.status]}
            {t.renamed_from ? `, was ${t.renamed_from}` : ""}
          </span>
          <ul className="rv-list">
            {t.columns.map((c) => (
              <li key={c.name} className={`mono rv-st-${c.status}`}>
                {MARK[c.status] || " "} {c.pk ? "PK " : c.fk ? "FK " : ""}
                {c.name} <span className="rv-dim">{c.type}</span>
                {c.fk ? <span className="rv-dim"> → {c.fk}</span> : null}
                {c.was ? <span className="rv-dim"> ({c.was})</span> : null}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

export function DatabaseTab({
  db,
  files,
  onOpen,
}: {
  db: DatabaseDiagram;
  files: Set<string>;
  onOpen: (path: string, line?: number | null) => void;
}) {
  const tables = db.tables ?? [];
  const ch = db.changes ?? { new: 0, changed: 0, removed: 0 };
  return (
    <div className="rv-stack" aria-label="Database change">
      <div className="rv-chips">
        {ch.new ? <Pill tone="ok">{ch.new} new</Pill> : null}
        {ch.changed ? <Pill tone="warn">{ch.changed} changed</Pill> : null}
        {ch.removed ? <Pill tone="bad">{ch.removed} removed</Pill> : null}
        {db.risks?.length ? (
          <Pill
            tone={db.risks.some((r) => r.severity === "high") ? "bad" : "warn"}
          >
            {db.risks.length} risk{db.risks.length === 1 ? "" : "s"}
          </Pill>
        ) : null}
      </div>
      {db.before && (
        <p className="rv-dim">
          Before: {db.before}. After: {db.after}.
        </p>
      )}
      {(db.notes ?? []).map((n) => (
        <p key={n} className="rv-warn">
          {n}
        </p>
      ))}
      {tables.length > 0 && db.mermaid && (
        <DiagramBox
          name="database-change"
          title="Database change diagram"
          mermaid={db.mermaid}
          ascii={db.ascii ?? ""}
          list={<TableList tables={tables} />}
        />
      )}
      {tables.length > 0 && (
        <p className="rv-dim rv-legend">
          <span className="rv-st-new">+ new</span> ·{" "}
          <span className="rv-st-changed">~ changed</span> ·{" "}
          <span className="rv-st-removed">− removed</span> ·{" "}
          <span className="rv-st-related">
            faded: not changed, linked by a foreign key
          </span>
        </p>
      )}
      {db.risks && db.risks.length > 0 && (
        <>
          <h4>Risks keel sees</h4>
          <ul className="rv-list rv-risks">
            {db.risks.map((r, i) => (
              <li key={i}>
                <Pill tone={RISK_TONE[r.severity] ?? "idle"}>{r.severity}</Pill>{" "}
                <OpenLink
                  path={r.path}
                  line={r.line}
                  onOpen={onOpen}
                  files={files}
                />{" "}
                {r.text}
                {r.uses && r.uses.length > 0 && (
                  <span className="rv-dim">
                    {" "}
                    Used in{" "}
                    {r.uses.map((u) => `${u.path}:${u.line}`).join(", ")}.
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {db.migrations && db.migrations.length > 0 && (
        <>
          <h4>Each change</h4>
          <ul className="rv-list rv-migs">
            {db.migrations.map((m) => (
              <li key={m.path}>
                <OpenLink path={m.path} onOpen={onOpen} files={files} />{" "}
                <span className="rv-dim">{m.framework}</span>
                {!m.parsed ? (
                  <span className="rv-warn"> not parsed — open the file</span>
                ) : (
                  <ul className="rv-list">
                    {m.steps.map((s, i) => (
                      <li
                        key={i}
                        className={s.kind === "unknown" ? "rv-warn" : undefined}
                      >
                        {s.line ? (
                          <span className="rv-dim mono">{s.line} </span>
                        ) : null}
                        {s.text}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {db.not_parsed && db.not_parsed.length > 0 && (
        <>
          <h4>Not read</h4>
          <ul className="rv-list" aria-label="Files keel could not read">
            {db.not_parsed.map((n, i) => (
              <li key={i}>
                <OpenLink
                  path={n.path}
                  line={n.line > 1 ? n.line : null}
                  onOpen={onOpen}
                  files={files}
                />{" "}
                <span className="rv-dim">
                  {n.why}: not parsed — open the file.
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="rv-dim">
        Read from the migrations with no model: keel's summary of what it can
        see, not a check.
      </p>
    </div>
  );
}

const EXT_WORD: Record<string, string> = {
  db: "database",
  queue: "queue / topic",
  "http-out": "HTTP service",
  "http-in": "incoming HTTP",
  cron: "scheduler",
  cli: "command line",
};

function SystemList({ sys }: { sys: SystemDiagram }) {
  const by = new Map(sys.nodes.map((n) => [n.id, n]));
  const name = (id: string) =>
    by.get(id)?.label ?? sys.externals.find((e) => e.id === id)?.label ?? id;
  return (
    <>
      <ul className="rv-list">
        {sys.groups.map((g) => (
          <li key={g.id}>
            <b>{g.title}</b>
            <ul className="rv-list">
              {g.nodes.map((id) => {
                const n = by.get(id)!;
                return (
                  <li key={id} className={`rv-st-${n.status}`}>
                    {MARK[n.status]} {n.label}{" "}
                    <span className="rv-dim">{n.layer}</span>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
      {sys.edges.length > 0 && (
        <ul className="rv-list" aria-label="How data moves">
          {sys.edges.map((e, i) => (
            <li key={i} className="mono">
              {name(e.from)} {e.kind === "guess" ? "⇢" : "→"} {name(e.to)}
              {e.label ? <span className="rv-dim"> ({e.label})</span> : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function SystemTab({ sys }: { sys: SystemDiagram }) {
  return (
    <div className="rv-stack" aria-label="System">
      <p className="rv-dim">
        {sys.nodes.length} changed part{sys.nodes.length === 1 ? "" : "s"} in{" "}
        {sys.groups.length} area{sys.groups.length === 1 ? "" : "s"}
        {sys.tests
          ? `, ${sys.tests} test file${sys.tests === 1 ? "" : "s"}`
          : ""}{" "}
        · from{" "}
        {sys.source === "map"
          ? "the Map's modules and the code"
          : "the paths and the code"}
      </p>
      {sys.nodes.length > 0 ? (
        <DiagramBox
          name="system-change"
          title="System diagram"
          mermaid={sys.mermaid}
          ascii={sys.ascii}
          list={<SystemList sys={sys} />}
        />
      ) : (
        <p className="rv-empty">No code part changed (only docs or tests).</p>
      )}
      <p className="rv-dim rv-legend">
        <span className="rv-st-added">+ new</span> ·{" "}
        <span className="rv-st-changed">~ changed</span> · a dotted arrow is a
        guess from the layers (the code does not name the other part)
      </p>
      {sys.externals.length > 0 && (
        <>
          <h4>Outside systems it touches</h4>
          <ul className="rv-list">
            {sys.externals.map((e) => (
              <li key={e.id}>
                <b>{e.label}</b>{" "}
                <span className="rv-dim">
                  {EXT_WORD[e.kind] ?? e.kind}
                  {e.detail ? ` · ${e.detail}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {sys.collapsed && (
        <p className="rv-dim">Not drawn: {sys.collapsed.label}.</p>
      )}
    </div>
  );
}

/**
 * The Database or System part for one review, from the shared load (diagramStore.ts): a wait, the error with Try
 * again, or the tab. The classic overview and the new Review view's tabs both show it.
 */
export function DiagramPart({ pid, reviewKey, view, part, onOpen }: {
  pid: string;
  reviewKey: string;
  view: ReviewView;
  part: "database" | "system";
  onOpen: (path: string, line?: number | null) => void;
}) {
  const e = useDiagrams(pid, reviewKey, view.head_sha);
  if (!e || e.status === "loading")
    return <div className="rv-dim pg-spin" role="status">keel reads the change…</div>;
  if (e.status === "error")
    return <ErrorBox error={e.error} onRetry={() => reloadDiagrams(pid, reviewKey, view.head_sha)} />;
  if (part === "database" && e.d.database.shown)
    return <DatabaseTab db={e.d.database} files={new Set(view.files.map((f) => f.path))} onOpen={onOpen} />;
  return <SystemTab sys={e.d.system} />;
}
