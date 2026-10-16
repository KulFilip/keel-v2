// v0.17.2 drawers of the Rules page: the rule library, a new or edited rule pack (form + YAML, check and dry-run), import.

import { useState } from "react";
import { errorParts } from "../api";
import { useApp, useLoad } from "../state";
import { KIND_WORDS, packYaml, rulesApi, type PackRule, type RuleCheck, type RulePack, type RulesView } from "../rulesApi";
import { CodeEditor } from "./CodeEditor";
import { Async, Drawer, ErrorBox, Tabs } from "./ui";

type Err = { message: string; hint?: string; details?: string[] } | null;

const toErr = (e: unknown): Err => {
  const p = errorParts(e);
  return { message: p.message, hint: p.hint };
};

export function LibraryDrawer({ pid, installed, onClose, onView }: {
  pid: string; installed: string[]; onClose: () => void; onView: (v: RulesView) => void;
}) {
  const { toast } = useApp();
  const lib = useLoad("rules:library", () => rulesApi.library());
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<Err>(null);
  const [have, setHave] = useState(installed);
  const install = async (p: RulePack) => {
    setBusy(p.id);
    setErr(null);
    try {
      const r = await rulesApi.install(pid, p.id);
      onView(r.view);
      setHave((h) => [...h, p.id]);
      toast(`${p.title} ${p.version} installed in .keel/rules/${p.id}.yaml. Agents meet it at their next tool call; commit the file to share it with the team.`);
    } catch (e) {
      setErr(toErr(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Drawer title="Rule library" onClose={onClose} id="ruleLibrary">
      <p className="sub" style={{ margin: 0 }}>Packs of rules keel ships. Installing one copies it into this project (.keel/rules/), where you can edit it and the team gets it with git.</p>
      {err && <ErrorBox error={err} />}
      <Async r={lib} what="Loading the library">
        {(items) => (
          <div className="grid" style={{ gap: 10 }}>
            {items.map((p) => (
              <div key={p.id} className="panel rl-libitem" data-lib={p.id}><div className="panel-body grid" style={{ gap: 6 }}>
                <div className="row" style={{ justifyContent: "space-between" }}><b>{p.title}</b>
                  <span className="row"><span className="tag">v{p.version}</span>{p.stack && <span className="tag">{p.stack}</span>}</span></div>
                <span className="sub">{p.summary}</span>
                <span className="hint">by {p.publisher}</span>
                <ul className="rl-libsum">{p.rules.map((r) => <li key={r.id}><span className="tag">{KIND_WORDS[r.kind]}</span> {r.reason}</li>)}</ul>
                <div className="row">
                  {have.includes(p.id) ? <span className="pill p-ok">installed</span>
                    : <button className="btn sm primary" type="button" disabled={busy === p.id} onClick={() => install(p)}>{busy === p.id ? "Installing…" : "Install"}</button>}
                </div>
              </div></div>
            ))}
          </div>
        )}
      </Async>
    </Drawer>
  );
}

// The starter pack: complete and valid as it is, in the style of keel's own packs (content/rules/).
const STARTER_RULE: PackRule = { id: "no-kubectl-apply", kind: "bash", match: ["kubectl apply", "helm upgrade"], how: "contains",
  phases: "all", reason: "Deploys are a person's job. Say what should be deployed and why in your answer." };
const STARTER = { name: "no-deploys", title: "No deploys", summary: "Agents never deploy; a person does." };

const DOCS = "https://github.com/MiladNalbandi/keel-v2/blob/main/docs/rules/pack-format.md";

/** The pack's fields in short, next to the YAML (docs/rules/pack-format.md has all of it). */
export function PackHelp() {
  const row = (field: string, values: string, example: string) => (
    <tr key={field}><td><code>{field}</code></td><td>{values}</td><td><code>{example}</code></td></tr>
  );
  return (
    <details className="rl-help">
      <summary>The fields of a rule pack</summary>
      <table>
        <thead><tr><th>Field</th><th>Allowed</th><th>Example</th></tr></thead>
        <tbody>
          {row("schema", "1 (required)", "schema: 1")}
          {row("name", "lower-case letters, digits, dashes; the file name", "name: no-deploys")}
          {row("title", "a few words", "title: No deploys")}
          {row("version", "x.y.z", "version: 1.0.0")}
          {row("publisher", "lower-case; local for your own", "publisher: local")}
          {row("summary", "one sentence (optional)", "summary: Agents never deploy.")}
          {row("requires.keel", "a version range (optional)", "keel: '>=0.17.2'")}
          {row("rules[].id", "lower-case letters, digits, dashes", "- id: no-kubectl-apply")}
          {row("rules[].kind", "bash · edit · read · mcp", "kind: bash")}
          {row("rules[].match", "a text or a list of texts", "match: [kubectl apply]")}
          {row("rules[].how", "contains · glob · name · regex (optional)", "how: regex")}
          {row("rules[].phases", "all · in-flow · none · a list of phases", "phases: [green, refactor]")}
          {row("rules[].lanes", "api · web (optional)", "lanes: [web]")}
          {row("rules[].except", "paths that pass (edit, read)", "except: ['**/*.lock']")}
          {row("rules[].reason", "plain words; the agent reads them", "reason: Deploys are a person's job.")}
        </tbody>
      </table>
      <a href={DOCS} target="_blank" rel="noreferrer">The whole format: docs/rules/pack-format.md</a>
    </details>
  );
}

/** New rule (no `pack`) or edit an installed pack. The form writes YAML; the YAML view is the file as saved. */
export function PackDrawer({ pid, pack, onClose, onView }: { pid: string; pack?: RulePack; onClose: () => void; onView: (v: RulesView) => void }) {
  const { toast } = useApp();
  const editing = !!pack;
  const [view, setView] = useState<"form" | "yaml">(editing ? "yaml" : "form");
  const [id, setId] = useState(pack?.id ?? STARTER.name);
  const [name, setName] = useState(pack?.title ?? STARTER.title);
  const [rule, setRule] = useState<PackRule>(pack?.rules[0] ?? STARTER_RULE);
  const [match, setMatch] = useState((pack?.rules[0]?.match ?? STARTER_RULE.match).join("\n"));
  const [yaml, setYaml] = useState<string | null>(null);
  const [check, setCheck] = useState<RuleCheck | null>(null);
  const [err, setErr] = useState<Err>(null);
  const [busy, setBusy] = useState(false);
  const loaded = useLoad(`rules:pack:${pid}:${pack?.id ?? ""}`, () => (pack ? rulesApi.text(pid, pack.id) : Promise.resolve("")), { live: false });
  const fromForm = () => packYaml({ name: id, title: name, summary: pack?.summary ?? STARTER.summary,
    rules: [{ ...rule, match: match.split("\n").map((s) => s.trim()).filter(Boolean) }] });
  const text = yaml ?? (editing ? loaded.data ?? "" : fromForm());
  const runCheck = async () => {
    setBusy(true);
    setErr(null);
    try {
      setCheck(await rulesApi.check(pid, text));
    } catch (e) {
      setErr(toErr(e));
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      // check first: errors show at their line, nothing is saved; keel saves the pack tidy (2 spaces, long lists per line)
      const c = await rulesApi.check(pid, text);
      if (!c.ok) {
        setCheck(c);
        if (view === "form" && !editing) setView("yaml");
        return;
      }
      const r = editing ? await rulesApi.edit(pid, pack!.id, text) : await rulesApi.add(pid, text);
      onView(r.view);
      toast(`${r.pack.title} saved in .keel/rules/${r.pack.id}.yaml. Agents meet it at their next tool call.`);
      onClose();
    } catch (e) {
      setErr(toErr(e));
    } finally {
      setBusy(false);
    }
  };
  const setKind = (kind: PackRule["kind"]) => setRule({ ...rule, kind, how: { bash: "contains", edit: "glob", read: "glob", mcp: "name" }[kind] });
  return (
    <Drawer title={editing ? `Edit ${pack!.title}` : "New rule"} onClose={onClose} id="packDrawer"
      footer={<>
        <button className="btn" type="button" onClick={onClose}>Cancel</button>
        <button className="btn" type="button" id="checkRule" onClick={runCheck} disabled={busy}>Check and try it</button>
        <button className="btn primary" type="button" id="saveRule" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
      </>}>
      {!editing && <Tabs value={view} onChange={(v) => { if (v === "yaml" && yaml === null) setYaml(fromForm()); setView(v as "form" | "yaml"); }} label="Rule view"
        options={[["form", "Form"], ["yaml", "YAML"]]} />}
      {view === "form" && !editing ? (
        <>
          <div className="field"><label htmlFor="rp-name">Pack name</label><input type="text" id="rp-name" value={name} onChange={(e) => { setName(e.target.value); setYaml(null); }} /></div>
          <div className="field"><label htmlFor="rp-id">File name (id)</label><input type="text" id="rp-id" value={id} onChange={(e) => { setId(e.target.value); setYaml(null); }} />
            <span className="hint">.keel/rules/{id}.yaml · lower-case letters, digits and dashes</span></div>
          <div className="field"><label htmlFor="rp-kind">What it stops</label>
            <select id="rp-kind" value={rule.kind} onChange={(e) => { setKind(e.target.value as PackRule["kind"]); setYaml(null); }}>
              <option value="bash">a shell command</option><option value="edit">a file change</option>
              <option value="read">a file read</option><option value="mcp">an MCP tool</option>
            </select></div>
          <div className="field"><label htmlFor="rp-match">{rule.kind === "bash" ? "Commands that contain" : rule.kind === "mcp" ? "Tool names that contain" : "Files (globs, like **/*.pem)"}</label>
            <textarea id="rp-match" rows={4} spellCheck={false} value={match} onChange={(e) => { setMatch(e.target.value); setYaml(null); }} placeholder="one per line" /></div>
          <div className="field"><label htmlFor="rp-phases">When</label>
            <select id="rp-phases" value={Array.isArray(rule.phases) ? "all" : rule.phases} onChange={(e) => { setRule({ ...rule, phases: e.target.value }); setYaml(null); }}>
              <option value="all">always</option><option value="in-flow">only in a flow</option><option value="none">only outside a flow (KeelBot, side sessions)</option>
            </select></div>
          <div className="field"><label htmlFor="rp-reason">Why (the agent reads this)</label>
            <input type="text" id="rp-reason" value={rule.reason} onChange={(e) => { setRule({ ...rule, reason: e.target.value }); setYaml(null); }} placeholder="e.g. Deploys are a person's job." /></div>
        </>
      ) : (
        <div className="field"><label htmlFor="rp-yaml">YAML</label>
          <CodeEditor id="rp-yaml" label="YAML" value={text} onChange={(v) => { setYaml(v); setCheck(null); }} errors={check?.lines ?? []} />
          <PackHelp /></div>
      )}
      {check && <CheckResult c={check} marked={view === "yaml" || editing} />}
      {err && <ErrorBox error={err} />}
    </Drawer>
  );
}

/** `marked`: the YAML editor is on screen and lists the errors at their lines; otherwise they are listed here. */
function CheckResult({ c, marked = false }: { c: RuleCheck; marked?: boolean }) {
  if (!c.ok) {
    return (
      <div className="errbox" role="status"><b>Not valid yet — nothing was saved.</b>
        {marked && c.lines?.length ? <span>Fix the marked lines in the YAML ({c.lines.length}).</span>
          : (c.lines?.length ? c.lines.map((l) => `line ${l.line}: ${l.message}`) : c.errors).map((e, i) => <span key={i}>{e}</span>)}
      </div>
    );
  }
  const d = c.dry_run;
  return (
    <div className="rl-check" role="status">
      <b>✓ Valid.</b>{" "}
      {d ? (d.blocked.length
        ? <>It would have refused <b>{d.blocked.length}</b> of the last {d.checked} tool calls in this project:</>
        : <>It would have refused none of the last {d.checked} tool calls in this project.</>)
        : <>No recent tool calls to try it on.</>}
      {d && d.blocked.length > 0 && (
        <ul className="rl-dry">{d.blocked.slice(0, 12).map((b, i) => (
          <li key={i}><span className="tag">{b.phase ?? "no phase"}</span> <span className="mono">{b.target}</span>{b.agent && <span className="sub"> · {b.agent}</span>}</li>
        ))}</ul>
      )}
    </div>
  );
}

export function ImportPackDrawer({ pid, onClose, onView }: { pid: string; onClose: () => void; onView: (v: RulesView) => void }) {
  const { toast } = useApp();
  const [yaml, setYaml] = useState("");
  const [err, setErr] = useState<Err>(null);
  const [check, setCheck] = useState<RuleCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const doImport = async () => {
    setBusy(true);
    setErr(null);
    try {
      const c = await rulesApi.check(pid, yaml);
      if (!c.ok) {
        setCheck(c);
        return;
      }
      const r = await rulesApi.add(pid, yaml);
      onView(r.view);
      toast(`${r.pack.title} imported into .keel/rules/${r.pack.id}.yaml.`);
      onClose();
    } catch (e) {
      setErr(toErr(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer title="Import a rule pack" onClose={onClose}
      footer={<><button className="btn" type="button" onClick={onClose}>Cancel</button>
        <button className="btn primary" type="button" onClick={doImport} disabled={busy || !yaml.trim()}>{busy ? "Reading…" : "Import"}</button></>}>
      <div className="field"><label htmlFor="ri-file">A .yaml file (from Export)</label>
        <input type="file" id="ri-file" accept=".yaml,.yml" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setYaml(await f.text()); setCheck(null); } }} /></div>
      <div className="field"><label htmlFor="ri-yaml">Or paste it</label>
        <CodeEditor id="ri-yaml" label="Or paste it" rows={14} value={yaml} onChange={(v) => { setYaml(v); setCheck(null); }} errors={check?.lines ?? []} />
        <PackHelp /></div>
      {check && !check.ok && <CheckResult c={check} marked />}
      {err && <ErrorBox error={err} />}
    </Drawer>
  );
}
