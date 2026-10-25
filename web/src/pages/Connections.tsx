// Connections (Control): which accounts the agents use — mode per provider, API keys (stored encrypted,
// never shown again), a test call per provider, and what is installed on this machine. Each provider's card shows at
// once with its own "Checking…" and fills in when the check answers; a card that misses a login says so first.
// The parts add their own kinds of account below the providers (slot connections.kind: Jira, GitHub, GitLab,
// Databases).

import { useEffect, useRef, useState } from "react";
import { api, errorParts, type Connections, type LoginView, type Mode, type Model } from "../api";
import { defaultModel, ModelPicker, modeLabel, useCatalog } from "../components/ModelPicker";
import { EmptyState, Section, Spinner } from "../components/page";
import { LoginDrawer, type LoginAdapter, type LoginCtx } from "../components/LoginDrawer";
import { ErrorBox, PageHead, Panel, Pill, Prov, type PillTone } from "../components/ui";
import { useApp, useLoad } from "../state";
import { UsageLine } from "../components/UsageStrip";
import { useSlot } from "../sdk/registry";
import { SLOTS, type ConnectionKindItem } from "../sdk/slots";
import { LocalServers, VertexSettings } from "../components/ModelServers";

const SECRET: Record<string, string> = { claude: "ANTHROPIC_API_KEY", codex: "OPENAI_API_KEY", copilot: "GITHUB_TOKEN" };
// How to get each CLI login; it is stored encrypted in keel's database and handed to the CLI inside the container.
const LOGIN_HELP: Record<string, { label: string; how: string; multiline?: boolean }> = {
  claude: { label: "Claude login token", how: "On your computer run `claude setup-token` and paste the token it prints." },
  codex: { label: "Codex login (auth.json)", how: "On your computer run `codex login`, then paste the content of ~/.codex/auth.json.", multiline: true },
  copilot: { label: "GitHub token for Copilot", how: "A GitHub token with Copilot access (github.com › Settings › Developer settings › Tokens)." },
};

/** One secret field: paste, save (encrypted), remove. Shows only the hint once saved. */
function SecretField({ id, name, label, how, set, hint, multiline }: { id: string; name: string; label: string; how: string; set: boolean; hint?: string | null; multiline?: boolean }) {
  const { toast } = useApp();
  const [value, setValue] = useState("");
  const [isSet, setIsSet] = useState(set);
  const [shown, setShown] = useState(hint ?? "");
  const save = async () => {
    if (!value.trim()) return;
    try {
      const r = await api.setSecret(name, value.trim());
      setValue("");
      setShown(r?.hint ?? "");
      setIsSet(true);
      toast("Saved and encrypted.");
    } catch (e) {
      const er = errorParts(e);    // a refused token says why and how to copy it again
      toast(er.hint ? `${er.message} ${er.hint}` : er.message);
    }
  };
  const remove = async () => {
    try {
      await api.deleteSecret(name);
      setIsSet(false);
      setShown("");
      toast("Removed.");
    } catch (e) {
      toast(errorParts(e).message);
    }
  };
  const placeholder = isSet ? `${shown || "••••"} (saved)` : multiline ? "paste here" : "paste the token";
  return (
    <div className="field">
      <label htmlFor={id}>{label} <span className="mono sub">{name}</span></label>
      <div className="row">
        {multiline
          ? <textarea id={id} value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} rows={3} style={{ flex: "1 1 220px", minHeight: 0 }} />
          : <input type="password" id={id} value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" placeholder={placeholder}
              style={{ flex: "1 1 220px" }} onKeyDown={(e) => e.key === "Enter" && void save()} />}
        <button className="btn sm" type="button" onClick={save} disabled={!value.trim()}>Save</button>
        {isSet && <button className="btn sm ghost" type="button" onClick={remove}>Remove</button>}
      </div>
      <span className="hint">{how} Stored encrypted in keel's database; only the last characters are shown.</span>
    </div>
  );
}

const USE: Record<string, string> = { claude: "research, tests, review", codex: "planning, review", copilot: "implementer, custom agents",
  vertex: "Claude and Gemini in your Google Cloud project", local: "Ollama, LM Studio, vLLM, llama.cpp — the code stays on your machines",
  fake: "tests and demos — no network" };
/** 0.18.46 providers set up with a form in their card (servers, a project), not with one key */
const CONFIGURED = new Set(["vertex", "local"]);


// ---- Login helper: log the CLI in from here (inside the container), or paste a token ----
const HELP: Record<string, { name: string; here: string; paste: { steps: string[]; link?: [string, string] } }> = {
  claude: {
    name: "Claude",
    here: "keel starts `claude setup-token` inside the container. You sign in on claude.com; the page then shows a code that you paste below. keel saves the long-lived token.",
    paste: { steps: ["On your computer run `claude setup-token`.", "Copy the whole token it prints (starts with sk-ant-oat, for example sk-ant-oat01-).", "Paste it below and press Save."] },
  },
  codex: {
    name: "GPT / Codex",
    here: "keel starts `codex login --device-auth` inside the container. You open a link, sign in with your ChatGPT account and type a short code. keel saves the login by itself.",
    paste: { steps: ["On your computer run `codex login`.", "Open ~/.codex/auth.json (for example: cat ~/.codex/auth.json | pbcopy).", "Paste the whole file below and press Save."] },
  },
  copilot: {
    name: "GitHub Copilot",
    here: "keel starts `copilot login --device-code` inside the container. You open github.com/login/device and type a short code. keel saves the GitHub token by itself.",
    paste: { steps: ["Create a fine-grained token on GitHub with the permission “Copilot Requests”. (Classic ghp_ tokens do not work.)", "Copy it.", "Paste it below and press Save."],
      link: ["https://github.com/settings/personal-access-tokens/new", "Create a token on GitHub"] },
  },
};

function LoginHelper({ p, onClose, onSaved }: { p: Connections["providers"][number]; onClose: () => void; onSaved: () => void }) {
  const h = HELP[p.id];
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  const adapter: LoginAdapter<LoginView> = {
    start: () => { setTest(null); setCode(""); return api.startLogin(p.id); },
    poll: (id) => api.login(id),
    cancel: (id) => api.cancelLogin(id),
  };
  // when it is saved: refresh the page behind and run the test once
  const done = () => {
    onSaved();
    if (p.selected !== "api") {
      api.testConnection(p.id).then((r) => live.current && setTest({ ok: r.ok, text: r.ok ? `${r.text ?? "OK"} · ${(r.ms / 1000).toFixed(1)}s` : (r.error ?? "no answer") }),
        (e) => live.current && setTest({ ok: false, text: errorParts(e).message }));
    }
  };
  const send = async ({ login, setLogin, setErr }: LoginCtx<LoginView>) => {
    if (!login || !code.trim()) return;
    setBusy(true); setErr(null);
    try { setLogin(await api.loginCode(login.id, code.trim())); setCode(""); } catch (e) { setErr(errorParts(e).message); } finally { setBusy(false); }
  };

  return (
    <LoginDrawer
      title={`Set up ${h.name} login`}
      intro={h.here}
      adapter={adapter}
      doneText={(v) => `${v.message} (${v.hint ?? "saved"})`}
      onDone={done}
      onClose={onClose}
      openHint={p.id === "claude" ? " and sign in with your Claude account" : ""}
      steps={(ctx) => p.id === "claude" && ctx.login?.status === "code_needed" ? (
        <li className="login-paste">
          <p className="sub" style={{ margin: 0 }} aria-label="Steps">
            <b>1</b> Open claude.com · <b>2</b> Log in · <b>3</b> Copy the code · <b>4</b> Paste it here
          </p>
          <label htmlFor="login-code"><b>After you sign in, the page shows a code. Paste it here:</b></label>
          <div className="row">
            <input id="login-code" type="text" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" placeholder="code from the Claude page"
              autoFocus style={{ flex: "1 1 220px", fontSize: "1.05em", padding: "8px 10px" }} onKeyDown={(e) => e.key === "Enter" && void send(ctx)} />
            <button className="btn primary" type="button" onClick={() => void send(ctx)} disabled={busy || !code.trim()}>Send</button>
          </div>
          <p className="sub" style={{ margin: 0 }}>Use the link from this box; a code from an older tab will not work.</p>
        </li>
      ) : null}
      status={test && <div className={test.ok ? "okc" : "badc"}>{test.ok ? "Test: " : "Test failed: "}{test.text}</div>}
      tabs={
        <div className="grid" style={{ gap: 12 }}>
          <ol className="steps">{h.paste.steps.map((x) => <li key={x}>{x}</li>)}</ol>
          {h.paste.link && <a className="btn sm" href={h.paste.link[0]} target="_blank" rel="noreferrer">{h.paste.link[1]}</a>}
          {p.login_secret && (
            <SecretField id={`helper-${p.id}`} name={p.login_secret} label={LOGIN_HELP[p.id]?.label ?? "Login"} how="" set={!!p.login_set}
              hint={p.login_hint} multiline={LOGIN_HELP[p.id]?.multiline} />
          )}
        </div>
      }
    />
  );
}

type Conn = Connections["providers"][number];
type State = { tone: PillTone; text: string; need?: "login" | "key" | "cli" | "opencode" };
const CLI: Record<string, string> = { claude: "claude CLI", codex: "codex CLI", copilot: "Copilot CLI" };

/** Can this provider's agents run now, and if not, what is missing (a login, a key, the CLI)? */
export function connState(p: Conn): State {
  if (p.id === "fake") return { tone: "ok", text: "Ready, no network" };
  if (CONFIGURED.has(p.id)) return p.key_set ? { tone: "ok", text: p.id === "local" ? "Ready, on your machines" : "Ready" } : { tone: "warn", text: "Not set up", need: "key" };
  const m = p.modes.find((x) => x.id === p.selected);
  if (p.selected === "api") return p.key_set ? { tone: "ok", text: "API key saved" } : { tone: "warn", text: "No API key", need: "key" };
  // OpenCode keeps its own login (opencode auth login), not keel's Copilot token: the api says whether it has one
  if (p.selected === "opencode" && m && !m.ready && m.need === "login") return { tone: "warn", text: "No OpenCode login", need: "opencode" };
  if (m && !m.ready && m.need !== "login") return { tone: "bad", text: `${p.selected === "opencode" ? "OpenCode" : CLI[p.id] ?? "CLI"} not installed`, need: "cli" };
  if (p.login_secret && !p.login_set) return { tone: "warn", text: "No login saved", need: "login" };
  return { tone: "ok", text: p.login_set ? "Ready, logged in" : "Ready" };
}

/** B8a the agents' models that are still the fake model (default, implementer, reviewer), in words. */
const AGENT_MODELS = [["default_model", "the default model"], ["implementer_model", "the implementer"], ["reviewer_model", "the reviewer"]] as const;
function fakeAgents(s: Partial<Record<string, unknown>> | null | undefined): string[] {
  if (!s) return [];
  return AGENT_MODELS.filter(([k]) => (s[k] as Model | undefined)?.provider === "fake").map(([, words]) => words);
}

function Provider({ p, onChanged, fake = [] }: { p: Conn; onChanged: () => void; fake?: string[] }) {
  const { toast } = useApp();
  const [key, setKey] = useState("");
  const [hint, setHint] = useState(p.key_hint ?? "");
  const [keySet, setKeySet] = useState(p.key_set);
  const [mode, setMode] = useState<Mode>(p.selected);
  const [test, setTest] = useState<{ ok?: boolean; text: string } | null>(null);
  const [helper, setHelper] = useState(false);
  const catalog = useCatalog();
  // The model "Use for all agents" sets: this provider, the mode picked above, a model and effort from the catalog.
  const [allModel, setAllModel] = useState<Model | null>(null);
  const forAll: Model = allModel && allModel.mode === mode ? allModel : defaultModel(catalog, p.id, mode);
  const secret = SECRET[p.id];
  const state = connState({ ...p, selected: mode, key_set: keySet });
  const pick = async (m: Mode) => {
    const old = mode;
    setMode(m);
    try {
      await api.setMode(p.id, m);
      toast(`${p.label}: ${p.modes.find((x) => x.id === m)?.label ?? m}`);
      onChanged();
    } catch (e) {
      setMode(old);
      toast(errorParts(e).message);
    }
  };
  const saveKey = async () => {
    if (!key.trim() || !secret) return;
    try {
      const r = await api.setSecret(secret, key.trim());
      setKey("");
      setHint(r?.hint ?? "");
      setKeySet(true);
      toast("Saved and encrypted.");
    } catch (e) {
      toast(errorParts(e).message);
    }
  };
  const useForAll = async () => {
    const m: Model = { ...forAll, provider: p.id, mode, model: forAll.model.trim() || defaultModel(catalog, p.id, mode).model };
    try {
      await api.saveGeneralSettings({ default_model: m, implementer_model: m, reviewer_model: m });
      toast(`All agents now use ${p.label} ${m.model}${m.effort ? ` (${m.effort})` : ""} · ${p.modes.find((x) => x.id === mode)?.label ?? modeLabel(p.id, mode)}. Change single agents in Agents.`);
      onChanged();
    } catch (e) {
      toast(errorParts(e).message);
    }
  };
  const runTest = async () => {
    setTest({ text: "sending “Reply with exactly: OK”…" });
    try {
      const r = await api.testConnection(p.id);
      setTest(r.ok ? { ok: true, text: `${r.text ?? "OK"} · ${(r.ms / 1000).toFixed(1)}s` } : { ok: false, text: r.error ?? "no answer" });
    } catch (e) {
      const er = errorParts(e);
      setTest({ ok: false, text: er.hint ? `${er.message} ${er.hint}` : er.message });
    }
  };
  const focusKey = () => document.getElementById(`key-${p.id}`)?.focus();
  const head = `conn-${p.id}`;
  return (
    <article className={`panel cn-card${state.need ? " is-need" : ""}`} aria-labelledby={head} data-testid={`conn-${p.id}`}>
      {helper && <LoginHelper p={p} onClose={() => setHelper(false)} onSaved={onChanged} />}
      <header className="cn-head">
        <div className="cn-id">
          <h2 id={head}><Prov p={p.id} /></h2>
          <span className="sub">{USE[p.id] ?? p.label}</span>
        </div>
        <div className="cn-state">
          <Pill tone={state.tone}>{state.text}</Pill>
          {test && <span className="hint cn-test" role="status">{test.ok === true ? <b className="okc">Test OK</b> : test.ok === false ? <b className="badc">Test failed</b> : null} {test.text}</span>}
        </div>
        <div className="cn-actions">
          {HELP[p.id] && (
            <button className={`btn sm${state.need === "login" ? " primary" : ""}`} type="button" onClick={() => setHelper(true)}>{p.login_set ? "Log in again" : "Set up login"}</button>
          )}
          {state.need === "key" && secret && <button className="btn sm primary" type="button" onClick={focusKey}>Add the key</button>}
          {state.need === "key" && CONFIGURED.has(p.id) && (
            <button className="btn sm primary" type="button" onClick={() => document.querySelector<HTMLElement>(`#conn-${p.id}-setup input, #conn-${p.id}-setup button`)?.focus()}>Set up</button>
          )}
          <button className="btn sm" type="button" onClick={runTest}>Test</button>
        </div>
      </header>
      {p.id !== "fake" && fake.length > 0 && state.tone === "ok" && (p.login_set || keySet) && (
        <p className="cn-need" role="note">
          {HELP[p.id]?.name ?? p.label} is {p.login_set ? "logged in" : "ready"}, but {fake.join(", ")} still use{fake.length === 1 ? "s" : ""} the fake model, so
          those agents do no real work. <button className="btn sm primary" type="button" onClick={useForAll}>Use {p.label} for all agents</button>
        </p>
      )}
      {state.need === "login" && <p className="cn-need">keel has no {HELP[p.id]?.name ?? p.label} login yet, so its agents cannot use your subscription. <b>Set up login</b> signs in from here, or paste a token.</p>}
      {state.need === "opencode" && <p className="cn-need">OpenCode has no GitHub Copilot login yet, so its agents cannot run. Run <code>opencode auth login</code> inside keel's container (for example <code>docker exec -it keel-v2 opencode auth login</code>), then press <b>Test</b>.</p>}
      {state.need === "cli" && <p className="cn-need">The {p.modes.find((x) => x.id === mode)?.label ?? "CLI"} is not installed in keel's image. Pick another way below, or build the image with INSTALL_CLIS=1.</p>}
      <div className="cn-body">
        <fieldset className="cn-modes">
          <legend className="lab">How agents reach {HELP[p.id]?.name ?? p.label}</legend>
          {p.modes.map((m) => (
            <label key={m.id} className="radio">
              <input type="radio" name={`mode-${p.id}`} value={m.id} checked={mode === m.id} onChange={() => void pick(m.id)} />
              <span className="cn-mode"><b>{m.label}</b><span className="sub">{m.detail}</span>{m.ready ? <span className="okc cn-ready">ready</span> : <span className="hint">not ready</span>}</span>
            </label>
          ))}
        </fieldset>
        <div className="cn-side">
          {CONFIGURED.has(p.id) && (
            <div id={`conn-${p.id}-setup`}>
              {p.id === "local" ? <LocalServers onChanged={onChanged} /> : <VertexSettings onChanged={onChanged} />}
            </div>
          )}
          {p.login_secret && LOGIN_HELP[p.id] && (
            <SecretField id={`login-${p.id}`} name={p.login_secret} label={LOGIN_HELP[p.id].label} how={LOGIN_HELP[p.id].how}
              set={!!p.login_set} hint={p.login_hint} multiline={LOGIN_HELP[p.id].multiline} />
          )}
          {secret && (
            <div className="field">
              <label htmlFor={`key-${p.id}`}>{secret}</label>
              <div className="row">
                <input type="password" id={`key-${p.id}`} value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off"
                  placeholder={keySet ? `${hint || "••••"} (saved)` : "paste the key"} style={{ flex: "1 1 200px" }}
                  onKeyDown={(e) => e.key === "Enter" && void saveKey()} />
                <button className="btn sm" type="button" onClick={saveKey} disabled={!key.trim()}>Save</button>
                {keySet && <button className="btn sm ghost" type="button" onClick={async () => {
                  try {
                    await api.deleteSecret(secret);
                    setKeySet(false);
                    setHint("");
                    toast("Key removed.");
                  } catch (e) {
                    toast(errorParts(e).message);
                  }
                }}>Remove</button>}
              </div>
              <span className="hint">For the API key way. Stored encrypted; only the last characters are shown. Subscription mode removes it from the CLI's environment.</span>
            </div>
          )}
          {p.id !== "fake" && (
            <div className="field">
              <span className="lab">Model for all agents</span>
              <div className="row">
                <ModelPicker id={`all-${p.id}`} value={forAll} onChange={setAllModel} provider={false} mode={false} />
                <button className="btn sm" type="button" onClick={useForAll}>Use for all agents</button>
              </div>
              <span className="hint">Sets the default, implementer and reviewer model, on the way chosen here.</span>
            </div>
          )}
          {p.id !== "fake" && <UsageLine provider={p.id} />}
        </div>
      </div>
    </article>
  );
}

/** Known providers in the order the page shows them; a card shows at once and fills in when the check answers. */
const ORDER = ["claude", "codex", "copilot", "vertex", "local", "fake"];
const order = (a: Conn, b: Conn) => (ORDER.indexOf(a.id) + 1 || 99) - (ORDER.indexOf(b.id) + 1 || 99);

function CheckingCard({ id }: { id: string }) {
  return (
    <article className="panel cn-card is-loading" aria-busy="true" data-testid={`conn-${id}`}>
      <header className="cn-head">
        <div className="cn-id"><h2><Prov p={id} /></h2><span className="sub">{USE[id]}</span></div>
        <div className="cn-state"><Spinner>Checking</Spinner></div>
      </header>
      <div className="cn-body"><span className="pg-skel" aria-hidden="true" /><span className="pg-skel" style={{ width: "70%" }} aria-hidden="true" /></div>
    </article>
  );
}

export function ConnectionsPage({ pid }: { pid: string }) {
  const conns = useLoad("connections", () => api.connections(), { live: false });
  const general = useLoad("settings:general", () => api.generalSettings(), { live: false });
  const fake = fakeAgents(general.data as Partial<Record<string, unknown>> | null);
  const kinds = useSlot<ConnectionKindItem>(SLOTS.connectionsKind);
  const c = conns.data;
  const providers = c ? [...c.providers].sort(order) : null;
  const missing = providers?.filter((p) => connState(p).need).length ?? 0;
  return (
    <>
      <PageHead title="Connections" sub="Which accounts the agents use, and what is installed. Keys are encrypted and never shown again in full." />
      {conns.error && <div style={{ marginBottom: 16 }}><ErrorBox error={conns.error} onRetry={() => void conns.reload()} /></div>}
      <Section title="Providers" sub={!providers ? "Checking each provider: which CLIs are installed and which logins and keys are saved."
        : missing ? `${missing} provider${missing === 1 ? " needs" : "s need"} a login or a key before its agents can run.` : "Every provider is ready."}>
        <div className="cn-list">
          {providers ? providers.map((p) => <Provider key={p.id} p={p} fake={fake} onChanged={() => { void conns.reload(); void general.reload(); }} />)
            : !conns.error && ORDER.map((id) => <CheckingCard key={id} id={id} />)}
          {providers && !providers.length && <div className="panel"><EmptyState title="No provider known">The keel api lists none. Update keel and reload.</EmptyState></div>}
        </div>
      </Section>
      {kinds.map((k) => <k.component key={k.id} pid={pid} />)}
      <Section title="This machine" sub="Programs keel and its agents find in the container.">
        <Panel body="checks">
          {c ? c.machine.map((m) => (
            <span key={m.name} className="check">
              <span className={m.ok ? "ok" : "no"}>{m.ok ? "✓" : "!"}</span>{m.name}
              {m.version && <> <span className="mono sub">{m.version}</span></>}
              {!m.ok && !m.version && <> <span className="mono sub">not installed</span></>}
            </span>
          )) : !conns.error ? <Spinner>Checking what is installed</Spinner> : <span className="sub">Not checked.</span>}
        </Panel>
      </Section>
    </>
  );
}
