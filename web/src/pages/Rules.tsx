// v0.16.2 Build › Rules: every rule keel applies in this project, in plain words — what it does, when (phases), which
// engines check it before the action or only after the step, and where it is saved. Rule packs install from a library
// like workflows, or you write your own (form or YAML).

import { useState, type ReactNode } from "react";
import { errorParts } from "../api";
import { Async, Confirm, ErrorBox, PageHead, Panel } from "../components/ui";
import { LibraryDrawer, PackDrawer, ImportPackDrawer } from "../components/RuleDrawers";
import { useApp, useLoad } from "../state";
import { rulesApi, KIND_WORDS, WHEN_WORDS, type Engine, type Enforced, type RuleList, type RulePack, type RulesView, type When } from "../rulesApi";

const ENGINES: [Engine, string][] = [["claude", "Claude"], ["opencode", "OpenCode"], ["codex", "Codex"], ["copilot", "Copilot"], ["api", "API key"]];
const ICON: Record<When, string> = { before: "✓", wrapped: "◐", after: "↺", none: "✗" };

export function WhenIcon({ when, engine }: { when: When; engine?: string }) {
  return <span className={`rl-when rl-${when}`} title={`${engine ? engine + ": " : ""}${WHEN_WORDS[when]}`} aria-label={`${engine ?? ""} ${WHEN_WORDS[when]}`}>{ICON[when]}</span>;
}

export function RulesLegend() {
  return (
    <div className="rl-legend" aria-label="Legend">
      {(Object.keys(ICON) as When[]).map((w) => <span key={w}><WhenIcon when={w} /> {WHEN_WORDS[w]}</span>)}
    </div>
  );
}

function EngineCells({ e }: { e?: Enforced }) {
  return <>{ENGINES.map(([id, name]) => <td key={id} className="rl-eng"><WhenIcon when={e?.[id] ?? "none"} engine={name} /></td>)}</>;
}

function EngineHead() {
  return <>{ENGINES.map(([id, name]) => <th key={id} className="rl-eng" scope="col">{name}</th>)}</>;
}

export function RulesPage({ pid }: { pid: string }) {
  const view = useLoad(`rules:${pid}`, () => rulesApi.view(pid), { live: false });
  const [drawer, setDrawer] = useState<"library" | "new" | "import" | null>(null);
  const [editing, setEditing] = useState<RulePack | null>(null);
  const set = (v: RulesView) => view.setData(() => v);
  return (
    <>
      <PageHead title="Rules"
        sub="What agents may and may not do in this project. keel checks every rule; some engines check it before the action, others only after the step."
        actions={<>
          <button className="btn" type="button" id="rulesLibrary" onClick={() => setDrawer("library")}>Library</button>
          <button className="btn" type="button" onClick={() => setDrawer("import")}>Import</button>
          <button className="btn primary" type="button" id="newRule" onClick={() => setDrawer("new")}>New rule</button>
        </>} />
      <Async r={view} what="Loading the rules">
        {(v) => (
          <div className="grid rl-page">
            <RulesLegend />
            <Engines v={v} />
            <Packs pid={pid} v={v} onView={set} onEdit={setEditing} onLibrary={() => setDrawer("library")} />
            <Builtins pid={pid} v={v} onView={set} />
            <Lists pid={pid} v={v} onView={set} />
            <Matrix v={v} />
          </div>
        )}
      </Async>
      {drawer === "library" && <LibraryDrawer pid={pid} installed={view.data?.packs.map((p) => p.id) ?? []} onClose={() => setDrawer(null)} onView={set} />}
      {drawer === "new" && <PackDrawer pid={pid} onClose={() => setDrawer(null)} onView={set} />}
      {drawer === "import" && <ImportPackDrawer pid={pid} onClose={() => setDrawer(null)} onView={set} />}
      {editing && <PackDrawer pid={pid} pack={editing} onClose={() => setEditing(null)} onView={set} />}
    </>
  );
}

function Engines({ v }: { v: RulesView }) {
  return (
    <Panel title="How each engine is checked">
      <div className="rl-engines">
        {v.engines.map((e) => (
          <div key={e.engine} className={`rl-engine rl-p-${e.protection}`}>
            <b>{ENGINES.find(([id]) => id === e.engine)?.[1] ?? e.engine}</b>
            <span className="sub">{e.words}</span>
          </div>
        ))}
      </div>
      <p className="hint" style={{ margin: "8px 0 0" }}>After every step keel also compares the files and puts back what the phase does not allow, for every engine.</p>
    </Panel>
  );
}

function Packs({ pid, v, onView, onEdit, onLibrary }: { pid: string; v: RulesView; onView: (v: RulesView) => void; onEdit: (p: RulePack) => void; onLibrary: () => void }) {
  const { toast } = useApp();
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const switchPack = async (p: RulePack) => {
    const current = new Set(offList(v));
    if (p.off) current.delete(`pack/${p.id}`); else current.add(`pack/${p.id}`);
    try {
      onView(await rulesApi.setConfig(pid, { rules: { off: [...current] } }));
      toast(`${p.name} is ${p.off ? "on" : "off"}. Running flows see it at their next tool call.`);
    } catch (e) {
      const x = errorParts(e);
      toast(x.hint ? `${x.message} ${x.hint}` : x.message);
    }
  };
  const remove = async (p: RulePack) => {
    setBusy(true);
    try {
      onView(await rulesApi.remove(pid, p.id));
      toast(`${p.name} removed (${p.file}).`);
    } catch (e) {
      toast(errorParts(e).message);
    } finally {
      setBusy(false);
      setRemoving(null);
    }
  };
  return (
    <Panel title={<h2>Rule packs <span className="sub">your own rules, saved in {v.rules_folder}/</span></h2>}
      extra={<button className="btn sm" type="button" onClick={onLibrary}>Add from the library</button>}>
      {v.pack_errors.length > 0 && (
        <div className="errbox" role="alert">
          {v.pack_errors.map((e) => <span key={e.file}><b>{e.file}</b> is not used: {e.errors.join("; ")}</span>)}
        </div>
      )}
      {v.packs.length === 0 ? (
        <div className="empty">No rule packs yet. Install one from the library ("No new dependencies", "Strict secrets", …) or write your own with New rule.</div>
      ) : v.packs.map((p) => (
        <div key={p.id} className={`rl-pack${p.off ? " rl-off" : ""}`} data-pack={p.id}>
          <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
            <div><b>{p.name}</b> {p.off && <span className="tag">off</span>}<div className="sub">{p.description}</div>
              <div className="hint">saved in <span className="mono">{p.file}</span></div></div>
            <div className="row">
              <label className="chk"><input type="checkbox" checked={!p.off} onChange={() => switchPack(p)} aria-label={`${p.name} on`} /> on</label>
              <button className="btn sm" type="button" onClick={() => onEdit(p)}>Edit</button>
              <a className="btn sm ghost" href={rulesApi.exportUrl(pid, p.id)} download={`${p.id}.rules.yaml`} style={{ textDecoration: "none" }}>Export</a>
              <button className="btn sm ghost" type="button" onClick={() => setRemoving(p.id)}>Remove</button>
            </div>
          </div>
          {removing === p.id && <Confirm text={`Remove ${p.name}? This deletes ${p.file}.`} yes="Remove" busy={busy} onYes={() => remove(p)} onNo={() => setRemoving(null)} />}
          <RuleTable rules={p.rules.map((r) => ({
            key: r.id, what: <><span className="tag">{KIND_WORDS[r.kind]}</span> {r.reason}</>,
            detail: <span className="mono">{r.match.join(", ")}{r.except?.length ? ` · except ${r.except.join(", ")}` : ""}</span>,
            when: phasesWords(r.phases) + (r.lanes?.length ? ` · ${r.lanes.join(", ")} lane` : ""), enforced: r.enforced, saved: p.file ?? "",
          }))} saved={false} />
        </div>
      ))}
    </Panel>
  );
}

function phasesWords(p: string | string[]): string {
  if (Array.isArray(p)) return `phases ${p.join(", ")}`;
  return { all: "always", "in-flow": "in a flow", none: "outside a flow" }[p] ?? p;
}

type Row = { key: string; what: ReactNode; detail?: ReactNode; when: string; enforced?: Enforced; saved: string; action?: ReactNode };

function RuleTable({ rules, saved = true }: { rules: Row[]; saved?: boolean }) {
  return (
    <div className="rl-scroll">
      <table className="rl-table">
        <thead><tr><th scope="col">Rule</th><th scope="col">When</th><EngineHead />{saved && <th scope="col">Saved in</th>}{rules.some((r) => r.action) && <th scope="col" />}</tr></thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.key} data-rule={r.key}>
              <td>{r.what}{r.detail && <div className="sub">{r.detail}</div>}</td>
              <td className="nowrap">{r.when}</td>
              <EngineCells e={r.enforced} />
              {saved && <td className="sub mono">{r.saved}</td>}
              {rules.some((x) => x.action) && <td>{r.action}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const offList = (v: RulesView): string[] => [
  ...v.builtins.filter((b) => b.off).map((b) => b.id),
  ...v.packs.filter((p) => p.off).map((p) => `pack/${p.id}`),
];

function Builtins({ pid, v, onView }: { pid: string; v: RulesView; onView: (v: RulesView) => void }) {
  const { toast } = useApp();
  const flip = async (id: string, on: boolean) => {
    const next = new Set(offList(v));
    if (on) next.delete(id); else next.add(id);
    try {
      onView(await rulesApi.setConfig(pid, { rules: { off: [...next] } }));
      toast(`${id} is ${on ? "on" : "off"}. Saved in .keel/config.yml (rules.off).`);
    } catch (e) {
      const x = errorParts(e);
      toast(x.hint ? `${x.message} ${x.hint}` : x.message);
    }
  };
  const always = v.builtins.filter((b) => !b.can_off);
  const switchable = v.builtins.filter((b) => b.can_off);
  return (
    <>
      <Panel title={<h2>Always on <span className="sub">they protect secrets, history and keel's record; they cannot be switched off</span></h2>}>
        <RuleTable rules={always.map((b) => ({ key: b.id, what: b.words, when: b.phases, enforced: b.enforced, saved: "keel (built in)",
          action: <span className="tag" title="This rule cannot be switched off">🔒 on</span> }))} />
      </Panel>
      <Panel title={<h2>keel's rules you can switch off <span className="sub">off is saved in .keel/config.yml (rules.off)</span></h2>}>
        {!v.configured && <p className="hint amber">This project has no .keel/config.yml yet: run keel init (Flow page) to change these.</p>}
        <RuleTable rules={switchable.map((b) => ({ key: b.id, what: b.words, when: b.phases, enforced: b.enforced, saved: b.off ? ".keel/config.yml" : "keel (built in)",
          action: <label className="chk"><input type="checkbox" checked={!b.off} disabled={!v.configured} onChange={(e) => flip(b.id, e.target.checked)} aria-label={`${b.id} on`} /> on</label> }))} />
      </Panel>
    </>
  );
}

function Lists({ pid, v, onView }: { pid: string; v: RulesView; onView: (v: RulesView) => void }) {
  return (
    <Panel title={<h2>This project's lists <span className="sub">in .keel/config.yml; keel's defaults until you change one</span></h2>}>
      {!v.configured && <p className="hint amber">This project has no .keel/config.yml yet: run keel init (Flow page) to change these.</p>}
      <p className="hint" style={{ marginTop: 0 }}>Saving rewrites only the guards, mcp, rules and boundaries parts of .keel/config.yml; comments inside those parts are lost, every other line stays.</p>
      <div className="rl-lists">
        {v.lists.map((l) => <ListEditor key={l.key} pid={pid} item={l} disabled={!v.configured} onView={onView} />)}
      </div>
    </Panel>
  );
}

type Boundary = { from: string; deny_imports?: string[]; allow_imports?: string[] };

function ListEditor({ pid, item, disabled, onView }: { pid: string; item: RuleList; disabled: boolean; onView: (v: RulesView) => void }) {
  const { toast } = useApp();
  const asText = (val: unknown): string => {
    if (item.form === "boundaries") return ((val as Boundary[]) ?? []).map((b) => `${b.from} -> ${(b.deny_imports ?? []).join(", ")}`).join("\n");
    if (Array.isArray(val)) return val.join("\n");
    return val == null ? "" : String(val);
  };
  const [text, setText] = useState(asText(item.value));
  const [flag, setFlag] = useState(item.value !== false);
  const [err, setErr] = useState<{ message: string; hint?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [block, key] = item.key.split(".");
  const value = (): unknown => {
    if (item.form === "bool") return flag;
    if (item.form === "number") return Number(text.trim() || 0);
    const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
    if (item.form === "boundaries") {
      return lines.map((l) => {
        const [from, deny = ""] = l.split("->").map((s) => s.trim());
        return { from, deny_imports: deny.split(",").map((s) => s.trim()).filter(Boolean) };
      });
    }
    return lines;
  };
  const save = async (next?: unknown) => {
    setBusy(true);
    setErr(null);
    try {
      onView(await rulesApi.setConfig(pid, { [block]: { [key]: next ?? value() } }));
      toast(`${item.key} saved in .keel/config.yml.`);
    } catch (e) {
      setErr(errorParts(e));
    } finally {
      setBusy(false);
    }
  };
  const id = `rl-${item.key.replace(".", "-")}`;
  return (
    <div className="rl-list field" data-list={item.key}>
      <label htmlFor={id}><span className="mono">{item.key}</span></label>
      <span className="sub">{item.words}</span>
      <div className="row rl-list-meta"><span className="hint">saved in {item.saved_in}</span>
        <span className="rl-mini">{ENGINES.map(([e, n]) => <WhenIcon key={e} when={item.enforced[e]} engine={n} />)}</span></div>
      {item.form === "bool" ? (
        <label className="chk"><input id={id} type="checkbox" checked={flag} disabled={disabled || busy}
          onChange={(e) => { setFlag(e.target.checked); void save(e.target.checked); }} /> {flag ? "on" : "off"}</label>
      ) : item.form === "number" ? (
        <div className="row"><input id={id} type="number" min={0} className="inline-input" value={text} disabled={disabled} onChange={(e) => setText(e.target.value)} style={{ width: 120 }} />
          <button className="btn sm" type="button" disabled={disabled || busy} onClick={() => save()}>Save</button></div>
      ) : (
        <>
          <textarea id={id} rows={Math.min(8, Math.max(3, text.split("\n").length + 1))} spellCheck={false} value={text} disabled={disabled}
            placeholder={item.form === "boundaries" ? "src/domain/** -> **/infrastructure/**, **/web/**" : "one per line"} onChange={(e) => setText(e.target.value)} />
          <div className="row"><button className="btn sm" type="button" disabled={disabled || busy} onClick={() => save()}>Save</button>
            {item.form === "boundaries" && <span className="hint">one rule per line: folder -&gt; imports it may not use (checked by keel's arch check)</span>}</div>
        </>
      )}
      {err && <ErrorBox error={err} />}
    </div>
  );
}

const CELL: Record<string, [string, string]> = {
  allow: ["✓", "may change"], "new-only": ["+", "new files only"], "delete-only": ["−", "may only delete lines"], deny: ["✗", "may not change"],
};

function Matrix({ v }: { v: RulesView }) {
  const buckets = v.buckets.filter((b) => !["protected-env", "generated", "keel-rules"].includes(b.bucket));
  return (
    <details className="panel rl-matrix">
      <summary className="panel-head"><h2>The phase matrix <span className="sub">what agents may change in each phase (built in)</span></h2></summary>
      <div className="panel-body rl-scroll">
        <table className="rl-table">
          <thead><tr><th scope="col">Phase</th>{buckets.map((b) => <th key={b.bucket} scope="col" title={b.what}>{b.what}</th>)}</tr></thead>
          <tbody>
            {v.phases.map((p) => (
              <tr key={p.phase}>
                <th scope="row" title={p.meaning}>{p.phase}</th>
                {buckets.map((b) => {
                  const r = p.matrix[b.bucket] ?? p.matrix["*"] ?? "deny";
                  const [icon, words] = CELL[r] ?? CELL.deny;
                  return <td key={b.bucket} className={`rl-cell rl-c-${r}`} title={words}>{icon}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hint">✓ may change · + new files only · − may only delete lines · ✗ may not change. .env files, generated code and keel's rule files are never changed by an agent.</p>
      </div>
    </details>
  );
}
