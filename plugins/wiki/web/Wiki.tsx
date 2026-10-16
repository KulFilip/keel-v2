// Wiki (Project): the knowledge base the librarians write, a page for every workflow (its Steps map, read only, or
// the graph), the setup runbook and decisions. The page id is in the hash: #/wiki/kb:architecture.
// The Wiki plugin's page (plugins/wiki): it imports only react, @keel/web-sdk and its own files. Its pages come from
// the plugin's api part (/wiki, /wiki/page); "Refresh stale" is keel's (the Code page shows it too).
// 0.17.3 (docs/plugins/24-wiki-sections-spec-status.md): each menu section opens and closes (kept per project), and a
// spec shows which flow built it (a pill in the menu, a Build status box on its page with Resume or Start).

import { useEffect, useRef, useState } from "react";
import {
  Async, DocHistoryPanel, EmptyState, ErrorBox, Loading, Markdown, PageHead, Pill, RefreshStaleButton, ResumeRow, SearchBox, Skeleton,
  StartFlowDrawer, StepInfoDrawer,
  agoText, get, go, hashForScreen, kfmt, plural, tokensByStep, useApp, useLoad, useNarrow, useRoute,
  type Estimate, type PillTone, type SpecState, type SpecStatus, type WikiPage as WikiPageData, type WikiTree, type Workflow,
} from "@keel/web-sdk";
import { WorkflowMap } from "./WorkflowMap";

const e = encodeURIComponent;

/** "?a=1&b=x" without the empty values, written as keel's api.ts writes a query. */
function query(params: Record<string, string | number | undefined | null>): string {
  const s = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") s.set(k, String(v));
  });
  const str = s.toString();
  return str ? "?" + str : "";
}

/** The page's reads: the same urls as keel 0.15.1 (its api.ts). */
const wikiApi = {
  wiki: (pid: string) => get<WikiTree>(`/projects/${e(pid)}/wiki`),
  wikiPage: (pid: string, id: string) => get<WikiPageData>(`/projects/${e(pid)}/wiki/page${query({ id })}`),
  workflow: (wid: string) => get<Workflow>(`/workflows/${e(wid)}`),
  estimate: (pid: string, workflow_id: string, acs: number) =>
    get<Estimate>(`/projects/${e(pid)}/estimate${query({ workflow_id, acs })}`),
  exportUrl: (wid: string) => `/api/workflows/${e(wid)}/export`,
  /** 0.17.3 every spec with the flow that built it (the Wiki plugin's api) */
  specStatus: (pid: string) => get<SpecStatus[]>(`/projects/${e(pid)}/specs/status`),
};

const STATUS: Record<string, ["ok" | "run" | "warn" | "idle", string]> = {
  written: ["ok", "written"], ok: ["ok", "written"], writing: ["run", "writing"], stale: ["warn", "stale"], missing: ["idle", "not written"],
};

/** A spec's state in words and as a pill tone. */
const SPEC: Record<SpecState, [PillTone, string]> = {
  built: ["ok", "built"], in_progress: ["run", "in progress"], stopped: ["warn", "stopped"], not_built: ["idle", "not built"],
};

// ---- which menu sections are closed: per project, in localStorage (a private window or blocked storage: in memory only)

const closedKey = (pid: string) => `keel.wiki.closed.${pid}`;

function readClosed(pid: string): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(closedKey(pid)) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeClosed(pid: string, ids: string[]) {
  try {
    localStorage.setItem(closedKey(pid), JSON.stringify(ids));
  } catch {
    /* no storage: the menu still works, it only forgets after a reload */
  }
}

function useClosed(pid: string) {
  const [closed, setClosed] = useState<string[]>(() => readClosed(pid));
  useEffect(() => setClosed(readClosed(pid)), [pid]);
  const toggle = (id: string) => setClosed((c) => {
    const next = c.includes(id) ? c.filter((x) => x !== id) : [...c, id];
    writeClosed(pid, next);
    return next;
  });
  return { closed, toggle };
}

type MenuProps = {
  tree: WikiTree; cur: string; q: string; closed: string[]; toggle: (id: string) => void;
  specs: Map<string, SpecStatus>; prefix: string; onPick?: () => void;
};

/** The sections and their pages (the side menu, and the phone's dropdown). A section's title opens and closes it; the
 *  section of the open page is always open; while searching, every section with a match shows its matches. */
function Sections({ tree, cur, q, closed, toggle, specs, prefix, onPick }: MenuProps) {
  const needle = q.trim().toLowerCase();
  return (
    <nav className="wtree" aria-label="Wiki pages">
      {tree.sections.map((s) => {
        const items = s.items.filter((i) => !needle || i.title.toLowerCase().includes(needle) || i.id.toLowerCase().includes(needle));
        if (!items.length && needle) return null;
        const pinned = s.items.some((i) => i.id === cur);
        const open = pinned || !!needle || !closed.includes(s.id);
        const list = `${prefix}-${s.id}`;
        return (
          <div key={s.id} className="wt-sec">
            <button type="button" className="wt-h" aria-expanded={open} aria-controls={list}
              aria-disabled={pinned ? true : undefined}
              title={pinned ? "The open page is in this section, so it stays open" : open ? `Close ${s.title}` : `Open ${s.title}`}
              onClick={() => { if (!pinned && !needle) toggle(s.id); }}>
              <span><span className="wt-car" aria-hidden="true">{open ? "▾" : "▸"}</span>{s.title}</span>
              {!open && <span className="sub">{plural(s.items.length, "page")}</span>}
            </button>
            <div id={list} className="wt-list" hidden={!open}>
              {items.map((i) => {
                const st = specs.get(i.id);
                return (
                  <a key={i.id} href={`#/wiki/${encodeURIComponent(i.id)}`} aria-current={cur === i.id ? "page" : undefined} onClick={onPick}>
                    {i.title}
                    {st ? <span className={`wk-sp wk-sp-${st.state}`}>{SPEC[st.state][1]}</span>
                      : i.status === "writing" ? <span className="adot" />
                      : i.status === "missing" ? <span className="sub wk-miss">not written</span>
                      : i.status === "stale" ? <span className="sub amber">stale</span> : null}
                  </a>
                );
              })}
              {!items.length && <span className="sub" style={{ padding: "2px 10px" }}>none yet</span>}
            </div>
          </div>
        );
      })}
    </nav>
  );
}

function WorkflowPage({ pid, wid }: { pid: string; wid: string }) {
  const wf = useLoad(`wf:${wid}`, () => wikiApi.workflow(wid));
  const est = useLoad(`wfest:${pid}:${wid}`, () => wikiApi.estimate(pid, wid, 3), { live: false });
  const [explain, setExplain] = useState<string | null>(null);
  return (
    <>
    {explain && <StepInfoDrawer pid={pid} workflow={wid} stepId={explain} onClose={() => setExplain(null)} />}
    <Async r={wf} what="Loading the workflow">
      {(w) => {
        const gates = w.steps.filter((s) => s.kind === "gate").length;
        const agents = new Set(w.steps.filter((s) => s.agent).map((s) => s.agent)).size;
        const tokens = tokensByStep(w, est.data);
        return (
          <>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h2 className="wh">{w.name}</h2>
              <div className="row">
                <button className="btn sm" type="button" onClick={() => go("workflows", w.id)}>Edit in builder</button>
                <a className="btn sm" href={wikiApi.exportUrl(w.id)} download={`${w.id}.workflow.yaml`} style={{ textDecoration: "none" }}>Export</a>
              </div>
            </div>
            <p className="sub" style={{ marginTop: 0 }}>
              {w.steps.length} steps · {agents} agents · {gates} gates wait for you · keel rules {w.keel_rules ? "on" : "off"} · version {w.version}
              {est.data ? ` · about ${kfmt(est.data.tokens)} tokens for 3 ACs` : ""}
            </p>
            <div style={{ margin: "12px 0" }}>
              <WorkflowMap id="wiki" title="Steps" steps={w.steps} tokens={tokens} onOpenStep={setExplain}
                label={`Steps of ${w.name}: ${w.steps.length} steps. Select one to see what it does.`} />
            </div>
            <p className="hint">This page is generated from the workflow file, so it is always the version that runs.</p>
          </>
        );
      }}
    </Async>
    </>
  );
}

/** What the spec page knows of its build status: the list's entry, or that the list is loading or failed. */
type SpecInfo = { status: SpecStatus | null; loading: boolean; failed: boolean; reload: () => Promise<void> };

function Page({ pid, id, spec }: { pid: string; id: string; spec?: SpecInfo }) {
  const page = useLoad(`wikipage:${pid}:${id}`, () => wikiApi.wikiPage(pid, id));
  if (page.error) return <ErrorBox error={page.error} onRetry={() => void page.reload()} />;
  if (!page.data) return <Loading />;
  const p = page.data;
  const meta = p.meta ?? {};
  const status = typeof meta.status === "string" ? STATUS[meta.status] : undefined;
  const facts = [
    meta.what, meta.words !== undefined && `${meta.words} words`, meta.cites !== undefined && `${meta.cites} citations`,
    meta.by && `by ${meta.by}`, meta.sha && `checked against HEAD ${String(meta.sha).slice(0, 7)}`, meta.updated && `updated ${meta.updated}`,
  ].filter(Boolean) as string[];
  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 className="wh">{p.title}</h2>
        {status && <Pill tone={status[0]}>{status[1]}</Pill>}
      </div>
      {facts.length > 0 && <p className="sub" style={{ marginTop: 0 }}>{facts.join(" · ")}</p>}
      {id.startsWith("spec:") && spec && (
        <SpecBuild pid={pid} path={id.slice(5)} title={p.title} acs={typeof meta.acs === "number" ? meta.acs : undefined} info={spec} />
      )}
      <div className="wdoc">{p.markdown ? <Markdown text={p.markdown} /> : <p className="sub">This page is empty.</p>}</div>
      {typeof meta.path === "string" && /^(spec|kb|adr):/.test(id) && <DocHistoryPanel pid={pid} path={meta.path} onRestored={() => void page.reload()} />}
      {id.startsWith("kb:") && <p className="hint">Every claim cites <span className="mono">file:line</span>. <span className="mono">memory check</span> opens each citation; a broken one fails the check.</p>}
    </>
  );
}

/** 0.17.3 which flow built this spec and where it is: built (a link), in progress (Open the flow), stopped (Resume, or
 *  why not and Start), not built (Start a flow from this spec, with the feature workflow and this spec as its input). */
function SpecBuild({ pid, path, title, acs, info }: { pid: string; path: string; title: string; acs?: number; info: SpecInfo }) {
  const [start, setStart] = useState(false);
  if (info.failed) return null;     // a keel without the status endpoint: the page as before
  if (!info.status) return info.loading ? <div className="wk-build"><Skeleton lines={1} label="Loading the build status" /></div> : null;
  const st = info.status;
  const [tone, label] = SPEC[st.state];
  const flow = st.thread_id ? hashForScreen("flow", st.thread_id) : undefined;
  const name = st.flow_title || st.thread_id || "";
  const wf = st.workflow ? ` (${st.workflow})` : "";
  const others = st.flows.filter((f) => f.thread_id !== st.thread_id);
  const startButton = (primary: boolean) => (
    <button className={primary ? "btn primary sm" : "btn sm"} type="button" onClick={() => setStart(true)}>Start a flow from this spec</button>
  );
  return (
    <section className="wk-build" aria-label="Build status">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <b>Build status</b>
        <Pill tone={tone}>{label}</Pill>
      </div>
      {st.state === "not_built" && (
        <>
          <p className="sub">No flow has built this spec yet. Start the feature flow from it: the flow keeps its criteria.</p>
          <div className="row">{startButton(true)}</div>
        </>
      )}
      {st.state === "built" && (
        <p className="sub">Built by the flow <a href={flow}>{name}</a>{wf}{st.updated_at ? `, finished ${agoText(st.updated_at)}` : ""}.</p>
      )}
      {st.state === "in_progress" && (
        <>
          <p className="sub">
            The flow <b>{name}</b>{wf} {st.status === "waiting" ? "waits" : "runs"}{st.phase ? <>, phase <span className="mono">{st.phase}</span></> : null}.
            {st.status === "waiting" && st.waiting ? <> It waits for you: <b>{st.waiting}</b>{/[.?!]$/.test(st.waiting) ? "" : "."}</> : null}
          </p>
          <div className="row"><a className="btn primary sm" href={flow} style={{ textDecoration: "none" }}>Open the flow</a></div>
        </>
      )}
      {st.state === "stopped" && (
        <>
          <p className="sub">
            The flow <a href={flow}>{name}</a>{wf} {st.status === "failed" ? "failed" : "stopped"}
            {st.phase ? <>, in phase <span className="mono">{st.phase}</span></> : null}.
          </p>
          {st.resumable && st.thread_id ? (
            <ResumeRow thread={{ thread_id: st.thread_id, status: st.status ?? "stopped" }} onDone={async () => go("flow", st.thread_id!)} />
          ) : (
            <>
              <p className="hint">{st.why ?? "Only the last stopped flow can be resumed."}</p>
              <div className="row">{startButton(false)}</div>
            </>
          )}
        </>
      )}
      {others.length > 0 && (
        <div className="wk-flows">
          <span className="lab-s">Other flows on this spec</span>
          <ul>
            {others.map((f) => (
              <li key={f.thread_id}>
                <a href={hashForScreen("flow", f.thread_id)}>{f.title || f.thread_id}</a>
                <span className={`wk-sp wk-sp-${f.state}`}>{SPEC[f.state][1]}</span>
                {f.updated_at && <span className="sub">{agoText(f.updated_at)}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {start && (
        <StartFlowDrawer projectId={pid} workflowId="feature" title={title} spec={{ path, acs: acs ?? st.acs }}
          onClose={() => { setStart(false); void info.reload(); }} />
      )}
    </section>
  );
}

/** On a phone: the menu as one dropdown ("Page: …") whose panel has the same sections, open and close, and pills. */
function PagePicker(props: MenuProps) {
  const { tree, cur } = props;
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const title = tree.sections.flatMap((s) => s.items).find((i) => i.id === cur)?.title;
  return (
    <div className="wk-pick" onKeyDown={(ev) => {
      if (ev.key === "Escape" && open) {
        setOpen(false);
        btn.current?.focus();
      }
    }}>
      <button ref={btn} type="button" className="wk-pick-btn" aria-expanded={open} aria-controls="wk-pick-list" onClick={() => setOpen((o) => !o)}>
        <span className="lab-s">Page</span>
        <b>{title ?? "Pick a page"}</b>
        <span aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      <div id="wk-pick-list" className="wk-pick-list" hidden={!open}>
        {open && <Sections {...props} onPick={() => setOpen(false)} />}
      </div>
    </div>
  );
}

export function WikiPage({ pid }: { pid: string }) {
  const { project } = useApp();
  const { arg } = useRoute();
  const tree = useLoad(`wiki:${pid}`, () => wikiApi.wiki(pid));
  const status = useLoad(`specstatus:${pid}`, () => wikiApi.specStatus(pid));
  const specs = new Map((status.data ?? []).map((x) => [x.spec, x]));
  const { closed, toggle } = useClosed(pid);
  const [q, setQ] = useState("");
  const narrow = useNarrow(900);
  const first = tree.data?.sections.flatMap((s) => s.items)[0]?.id;
  const cur = arg ?? first ?? "";
  const stale = (tree.data?.sections ?? []).flatMap((s) => s.items).filter((i) => i.status === "stale" && i.id.startsWith("kb:")).map((i) => i.id.slice(3));
  return (
    <>
      <PageHead title="Wiki"
        sub={`What keel knows about ${project?.name ?? pid}: the knowledge base the librarians write, a page for every workflow, the setup runbook and decisions.`}
        actions={<RefreshStaleButton pid={pid} sections={stale} className="btn" />} />
      {tree.data?.notice && <div className="errbox" role="alert" style={{ marginBottom: 16 }}><b>keel cannot see this project's own files:</b> {tree.data.notice}</div>}
      {tree.data?.layout === "repo" && <p className="hint">keel keeps this project's files in <span className="mono">docs/</span> (layout repo), committed with your code. New projects use <span className="mono">.keel/</span>.</p>}
      {tree.error ? <ErrorBox error={tree.error} onRetry={() => void tree.reload()} /> : !tree.data ? <div className="panel"><Skeleton lines={6} label="Loading the wiki" /></div> : (() => {
        const t = tree.data;
        if (!t.sections.some((s) => s.items.length)) {
          return <div className="panel"><EmptyState title="The wiki is empty" action={<a className="btn" href="#/flow">Open Flow</a>}>The init flow writes the knowledge base, and every workflow gets a page here. Start init from the Flow page.</EmptyState></div>;
        }
        const menu = { tree: t, cur, q, closed, toggle, specs };
        return (
          <div className="wiki-grid">
            <div>
              <div className="wk-search"><SearchBox value={q} onChange={setQ} label="Search the wiki" /></div>
              {narrow ? <PagePicker {...menu} prefix="wkp" /> : <Sections {...menu} prefix="wks" />}
            </div>
            <article className="panel"><div className="panel-body">
              {!cur ? <span className="sub">Pick a page.</span> : cur.startsWith("wf:") ? <WorkflowPage key={cur} pid={pid} wid={cur.slice(3)} /> : (
                <Page key={cur} pid={pid} id={cur}
                  spec={{ status: specs.get(cur) ?? null, loading: !status.data && !status.error, failed: !!status.error, reload: status.reload }} />
              )}
            </div></article>
          </div>
        );
      })()}
    </>
  );
}
