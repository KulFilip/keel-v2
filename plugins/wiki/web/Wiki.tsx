// Wiki (Project): the knowledge base the librarians write, a page for every workflow (its Steps map, read only, or
// the graph), the setup runbook and decisions. The page id is in the hash: #/wiki/kb:architecture.
// The Wiki plugin's page (plugins/wiki): it imports only react, @keel/web-sdk and its own files. Its pages come from
// the plugin's api part (/wiki, /wiki/page); "Refresh stale" is keel's (the Code page shows it too).
// 0.17.3 (docs/plugins/24-wiki-sections-spec-status.md): each menu section opens and closes (kept per project), and a
// spec shows which flow built it (a pill in the menu, a Build status box on its page with Resume or Start).
// The wiki's order (nav.ts): the menu is grouped by kind (Overview, Architecture & knowledge, Specs by build status,
// Decisions, Workflows) with counts, a stable order and readable titles; a page shows where it is (a breadcrumb) and,
// when long, what is on it.

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  Async, DocHistoryPanel, EmptyState, ErrorBox, Loading, Markdown, PageHead, Pill, RefreshStaleButton, ResumeRow, SearchBox, Skeleton,
  StartFlowDrawer, StepInfoDrawer,
  agoText, get, go, hashForScreen, kfmt, plural, tokensByStep, useApp, useLoad, useNarrow, useRoute,
  type Estimate, type PillTone, type SpecState, type SpecStatus, type WikiPage as WikiPageData, type WikiTree, type Workflow,
} from "@keel/web-sdk";
import { buildNav, filterNav, firstPage, groupCount, groupItems, placeOf, type NavGroup, type NavItem } from "./nav";
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
  /** every group of the menu (the place of the open page is found here), and the ones the search keeps */
  groups: NavGroup[]; shown: NavGroup[]; cur: string; q: string; closed: string[]; toggle: (id: string) => void;
  prefix: string; onPick?: () => void;
};

/** A page in the menu: its number, its title and what state it is in (a spec's build status, a knowledge section that
 *  is stale, being written or not written yet, a file that is also in another folder). */
function MenuLink({ item, cur, onPick }: { item: NavItem; cur: string; onPick?: () => void }) {
  const st = item.spec;
  return (
    <a href={`#/wiki/${encodeURIComponent(item.id)}`} aria-current={cur === item.id ? "page" : undefined} onClick={onPick}
      className={item.status === "missing" ? "wt-missing" : undefined} title={item.path ?? undefined}>
      <span className="wt-t">{item.number && <span className="wt-num">{item.number}</span>}{item.title}</span>
      {st ? <span className={`wk-sp wk-sp-${st.state}`}>{SPEC[st.state][1]}</span>
        : item.status === "writing" ? <span className="adot" />
        : item.status === "missing" ? <span className="sub wk-miss">not written</span>
        : item.status === "stale" ? <span className="sub amber">stale</span> : null}
      {item.also.length > 0 && <span className="sub wk-miss" title={`Also in ${item.also.join(", ")}`}>×{item.also.length + 1}</span>}
    </a>
  );
}

/** The groups and their pages (the side menu, and the phone's dropdown). A group's title opens and closes it and shows
 *  how many pages it has; the group of the open page is always open; while searching, every group with a match shows
 *  its matches. Specs are split by build status (In progress, Stopped, Not built yet, Done). */
function Sections({ groups, shown, cur, q, closed, toggle, prefix, onPick }: MenuProps) {
  const searching = !!q.trim();
  const here = placeOf(groups, cur)?.group.id;
  return (
    <nav className="wtree" aria-label="Wiki pages">
      {searching && !shown.length && <span className="sub" style={{ padding: "6px 10px" }}>No page matches “{q.trim()}”.</span>}
      {shown.map((g) => {
        const pinned = g.id === here;
        const open = pinned || searching || !closed.includes(g.id);
        const list = `${prefix}-${g.id}`;
        const n = groupCount(g);
        return (
          <div key={g.id} className="wt-sec">
            <button type="button" className="wt-h" aria-expanded={open} aria-controls={list}
              aria-disabled={pinned ? true : undefined}
              title={pinned ? "The open page is in this group, so it stays open" : open ? `Close ${g.title}` : `Open ${g.title}`}
              onClick={() => { if (!pinned && !searching) toggle(g.id); }}>
              <span><span className="wt-car" aria-hidden="true">{open ? "▾" : "▸"}</span>{g.title}</span>
              <span className="wt-n" aria-label={plural(n, "page")}>{n}</span>
            </button>
            <div id={list} className="wt-list" hidden={!open}>
              {g.parts.map((p) => (
                <div key={p.id} className="wt-part" role={p.title ? "group" : undefined} aria-label={p.title ? `${g.title}: ${p.title}` : undefined}>
                  {p.title && <span className="wt-sub">{p.title} <span className="wt-n">{p.items.length}</span></span>}
                  {p.items.map((i) => <MenuLink key={i.id} item={i} cur={cur} onPick={onPick} />)}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </nav>
  );
}

/** "Wiki › Specs › In progress": where the open page is in the menu. */
function Crumbs({ groups, cur }: { groups: NavGroup[]; cur: string }) {
  const at = placeOf(groups, cur);
  if (!at) return null;
  return (
    <nav className="wk-crumbs" aria-label="Breadcrumb">
      <a href="#/wiki">Wiki</a>
      <span aria-hidden="true">›</span>
      <span>{at.group.title}</span>
      {at.part.title && <><span aria-hidden="true">›</span><span>{at.part.title}</span></>}
    </nav>
  );
}

/** "On this page": the headings of a long page (three or more), each one scrolls to its place. The links stay
 *  buttons: the hash holds the page id (#/wiki/kb:architecture), so an anchor would change the page. */
function Toc({ doc, text }: { doc: RefObject<HTMLDivElement | null>; text: string }) {
  const [heads, setHeads] = useState<{ level: number; text: string; el: HTMLElement }[]>([]);
  useEffect(() => {
    const els = [...(doc.current?.querySelectorAll<HTMLElement>("h1, h2, h3") ?? [])];
    // the page's own title (a "# " first line) is the page heading already
    const body = els.length && els[0].tagName === "H1" && els.filter((e) => e.tagName === "H1").length === 1 ? els.slice(1) : els;
    setHeads(body.map((el) => ({ level: Number(el.tagName[1]), text: el.textContent ?? "", el })).filter((h) => h.text.trim()));
  }, [doc, text]);
  if (heads.length < 3) return null;
  const top = Math.min(...heads.map((h) => h.level));
  return (
    <details className="wk-toc" open>
      <summary>On this page <span className="wt-n">{heads.length}</span></summary>
      <ul aria-label="On this page">
        {heads.map((h, i) => (
          <li key={i} style={{ paddingLeft: (h.level - top) * 12 }}>
            <button type="button" className="linkbtn" onClick={() => h.el.scrollIntoView({ behavior: "smooth", block: "start" })}>{h.text}</button>
          </li>
        ))}
      </ul>
    </details>
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

function Page({ pid, id, spec, item }: { pid: string; id: string; spec?: SpecInfo; item?: NavItem }) {
  const page = useLoad(`wikipage:${pid}:${id}`, () => wikiApi.wikiPage(pid, id));
  const doc = useRef<HTMLDivElement>(null);
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
      {item && item.also.length > 0 && (
        <p className="hint">The same file is also in {item.also.map((a, i) => <span key={a}>{i ? ", " : ""}<span className="mono">{a}</span></span>)}: the menu shows it once, from <span className="mono">{item.path ?? id.replace(/^\w+:/, "")}</span>.</p>
      )}
      {p.markdown && <Toc doc={doc} text={p.markdown} />}
      <div className="wdoc" ref={doc}>{p.markdown ? <Markdown text={p.markdown} /> : <p className="sub">This page is empty.</p>}</div>
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
  const { groups, cur } = props;
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const title = placeOf(groups, cur)?.item.title;
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
  const specs = useMemo(() => new Map((status.data ?? []).map((x) => [x.spec, x])), [status.data]);
  const groups = useMemo(() => (tree.data ? buildNav(tree.data, specs) : []), [tree.data, specs]);
  const { closed, toggle } = useClosed(pid);
  const [q, setQ] = useState("");
  const shown = useMemo(() => filterNav(groups, q), [groups, q]);
  const narrow = useNarrow(900);
  const cur = arg ?? firstPage(groups) ?? "";
  const stale = groups.flatMap(groupItems).filter((i) => i.status === "stale" && i.id.startsWith("kb:")).map((i) => i.id.slice(3));
  const place = placeOf(groups, cur);
  return (
    <>
      <PageHead title="Wiki"
        sub={`What keel knows about ${project?.name ?? pid}: an overview, the knowledge base the librarians write, the specs by build status, the decisions and a page for every workflow.`}
        actions={<RefreshStaleButton pid={pid} sections={stale} className="btn" />} />
      {tree.data?.notice && <div className="errbox" role="alert" style={{ marginBottom: 16 }}><b>keel cannot see this project's own files:</b> {tree.data.notice}</div>}
      {tree.data?.layout === "repo" && <p className="hint">keel keeps this project's files in <span className="mono">docs/</span> (layout repo), committed with your code. New projects use <span className="mono">.keel/</span>.</p>}
      {tree.error ? <ErrorBox error={tree.error} onRetry={() => void tree.reload()} /> : !tree.data ? <div className="panel"><Skeleton lines={6} label="Loading the wiki" /></div> : (() => {
        if (!groups.length) {
          return <div className="panel"><EmptyState title="The wiki is empty" action={<a className="btn" href="#/flow">Open Flow</a>}>The init flow writes the knowledge base, and every workflow gets a page here. Start init from the Flow page.</EmptyState></div>;
        }
        const menu = { groups, shown, cur, q, closed, toggle };
        return (
          <div className="wiki-grid">
            <div className="wk-side">
              <div className="wk-search"><SearchBox value={q} onChange={setQ} label="Search the wiki" /></div>
              {narrow ? <PagePicker {...menu} prefix="wkp" /> : <Sections {...menu} prefix="wks" />}
            </div>
            <article className="panel"><div className="panel-body">
              <Crumbs groups={groups} cur={cur} />
              {!cur ? <span className="sub">Pick a page.</span> : cur.startsWith("wf:") ? <WorkflowPage key={cur} pid={pid} wid={cur.slice(3)} /> : (
                <Page key={cur} pid={pid} id={cur} item={place?.item}
                  spec={{ status: specs.get(cur) ?? null, loading: !status.data && !status.error, failed: !!status.error, reload: status.reload }} />
              )}
            </div></article>
          </div>
        );
      })()}
    </>
  );
}
