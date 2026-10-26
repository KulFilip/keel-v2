// keel 0.18.57 Settings › Models & logins: which accounts the agents use, which model each kind of agent runs on, and
// what is installed. One row per provider (Claude, GPT / Codex, GitHub Copilot, Vertex AI, Local models, Fake): its
// state ("Ready, logged in", "No login saved"), what it misses first, Set up login / Log in again / Add the key / Set
// up, and Test; open, it shows how agents reach it (subscription, API key, OpenCode), its login and key (stored
// encrypted, only the last characters shown), the model servers or the Google Cloud project, and "Use for all agents".
// Then the model of each kind of agent with its effort, "Local models only", and This machine.

import { useEffect, useRef, useState } from "react";
import {
  api,
  errorParts,
  type Connections,
  type LoginView,
  type Mode,
  type Model,
} from "../../api";
import {
  LoginDrawer,
  type LoginAdapter,
  type LoginCtx,
} from "../../components/LoginDrawer";
import { LocalServers, VertexSettings } from "../../components/ModelServers";
import {
  defaultModel,
  effortsOf,
  ModelPicker,
  modeLabel,
  useCatalog,
} from "../../components/ModelPicker";
import { EmptyState, Spinner } from "../../components/page";
import {
  Note,
  RadioCards,
  Seg,
  Tile,
  TonePill,
  type Tone,
} from "../../components/settingsUi";
import { ErrorBox } from "../../components/ui";
import { UsageLine } from "../../components/UsageStrip";
import { useStored } from "../../storage";
import { useApp, useLoad } from "../../state";
import { SettingsFrame, setSettingsHint } from "./frame";
import { GeneralRow, useScopedSettings, type Row } from "./rows";

const SECRET: Record<string, string> = {
  claude: "ANTHROPIC_API_KEY",
  codex: "OPENAI_API_KEY",
  copilot: "GITHUB_TOKEN",
};
// How to get each CLI login; it is stored encrypted in keel's database and handed to the CLI inside the container.
const LOGIN_HELP: Record<
  string,
  { label: string; how: string; multiline?: boolean }
> = {
  claude: {
    label: "Claude login token",
    how: "On your computer run `claude setup-token` and paste the token it prints.",
  },
  codex: {
    label: "Codex login (auth.json)",
    how: "On your computer run `codex login`, then paste the content of ~/.codex/auth.json.",
    multiline: true,
  },
  copilot: {
    label: "GitHub token for Copilot",
    how: "A GitHub token with Copilot access (github.com › Settings › Developer settings › Tokens).",
  },
};

const USE: Record<string, string> = {
  claude: "research, tests, review",
  codex: "planning, review",
  copilot: "implementer, custom agents",
  vertex: "Claude and Gemini in your Google Cloud project",
  local: "Ollama, LM Studio, vLLM, llama.cpp — the code stays on your machines",
  fake: "tests and demos — no network",
};
/** 0.18.46 providers set up with a form in their row (servers, a project), not with one key */
const CONFIGURED = new Set(["vertex", "local"]);
const NAME: Record<string, string> = {
  claude: "Claude",
  codex: "GPT / Codex",
  copilot: "GitHub Copilot",
  vertex: "Vertex AI",
  local: "Local models",
  fake: "Fake",
};

// ---- Login helper: log the CLI in from here (inside the container), or paste a token ----
const HELP: Record<
  string,
  {
    name: string;
    here: string;
    open?: string;
    paste: { steps: string[]; link?: [string, string] };
  }
> = {
  claude: {
    name: "Claude",
    here: "keel starts `claude setup-token` inside the container. You sign in on claude.com; the page then shows a code that you paste below. keel saves the long-lived token.",
    open: "Open claude.com and sign in with your Claude account",
    paste: {
      steps: [
        "On your computer run `claude setup-token`.",
        "Copy the whole token it prints (starts with sk-ant-oat, for example sk-ant-oat01-).",
        "Paste it below and press Save.",
      ],
    },
  },
  codex: {
    name: "GPT / Codex",
    here: "keel starts `codex login --device-auth` inside the container. You open a link, sign in with your ChatGPT account and type a short code. keel saves the login by itself.",
    paste: {
      steps: [
        "On your computer run `codex login`.",
        "Open ~/.codex/auth.json (for example: cat ~/.codex/auth.json | pbcopy).",
        "Paste the whole file below and press Save.",
      ],
    },
  },
  copilot: {
    name: "GitHub Copilot",
    here: "keel starts `copilot login --device-code` inside the container. You open github.com/login/device and type a short code. keel saves the GitHub token by itself.",
    paste: {
      steps: [
        "Create a fine-grained token on GitHub with the permission “Copilot Requests”. (Classic ghp_ tokens do not work.)",
        "Copy it.",
        "Paste it below and press Save.",
      ],
      link: [
        "https://github.com/settings/personal-access-tokens/new",
        "Create a token on GitHub",
      ],
    },
  },
};

type Conn = Connections["providers"][number];
type State = {
  tone: Tone;
  text: string;
  need?: "login" | "key" | "cli" | "opencode";
};
const CLI: Record<string, string> = {
  claude: "claude CLI",
  codex: "codex CLI",
  copilot: "Copilot CLI",
};
const PILL_TONE: Record<string, Tone> = { ok: "ok", warn: "warn", bad: "bad" };

/** Can this provider's agents run now, and if not, what is missing (a login, a key, the CLI)? */
export function connState(p: Conn): {
  tone: "ok" | "warn" | "bad";
  text: string;
  need?: State["need"];
} {
  if (p.id === "fake") return { tone: "ok", text: "Ready, no network" };
  if (CONFIGURED.has(p.id))
    return p.key_set
      ? {
          tone: "ok",
          text: p.id === "local" ? "Ready, on your machines" : "Ready",
        }
      : { tone: "warn", text: "Not set up", need: "key" };
  const m = p.modes.find((x) => x.id === p.selected);
  if (p.selected === "api")
    return p.key_set
      ? { tone: "ok", text: "API key saved" }
      : { tone: "warn", text: "No API key", need: "key" };
  // OpenCode keeps its own login (opencode auth login), not keel's Copilot token: the api says whether it has one
  if (p.selected === "opencode" && m && !m.ready && m.need === "login")
    return { tone: "warn", text: "No OpenCode login", need: "opencode" };
  if (m && !m.ready && m.need !== "login")
    return {
      tone: "bad",
      text: `${p.selected === "opencode" ? "OpenCode" : (CLI[p.id] ?? "CLI")} not installed`,
      need: "cli",
    };
  if (p.login_secret && !p.login_set)
    return { tone: "warn", text: "No login saved", need: "login" };
  return { tone: "ok", text: p.login_set ? "Ready, logged in" : "Ready" };
}

/** B8a the agents' models that are still the fake model (default, implementer, reviewer), in words. */
const AGENT_MODELS = [
  ["default_model", "the default model"],
  ["implementer_model", "the implementer"],
  ["reviewer_model", "the reviewer"],
] as const;
function fakeAgents(
  s: Partial<Record<string, unknown>> | null | undefined,
): string[] {
  if (!s) return [];
  return AGENT_MODELS.filter(
    ([k]) => (s[k] as Model | undefined)?.provider === "fake",
  ).map(([, words]) => words);
}

/** One secret: paste, Save (encrypted), Remove. Shows only the last characters once saved; a refused one says why. */
function SecretField({
  id,
  name,
  label,
  how,
  set,
  hint,
  multiline,
  onSaved,
  onRemoved,
}: {
  id: string;
  name: string;
  label: string;
  how: string;
  set: boolean;
  hint?: string | null;
  multiline?: boolean;
  onSaved?: (hint: string) => void;
  onRemoved?: () => void;
}) {
  const { toast } = useApp();
  const [value, setValue] = useState("");
  const [isSet, setIsSet] = useState(set);
  const [shown, setShown] = useState(hint ?? "");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setIsSet(set);
    setShown(hint ?? "");
  }, [set, hint]);
  const save = async () => {
    if (!value.trim()) return;
    setErr(null);
    try {
      const r = await api.setSecret(name, value.trim());
      setValue("");
      setShown(r?.hint ?? "");
      setIsSet(true);
      toast("Saved and encrypted.");
      onSaved?.(r?.hint ?? "");
    } catch (e) {
      const er = errorParts(e); // a refused token says why and how to copy it again
      setErr(er.hint ? `${er.message} ${er.hint}` : er.message);
    }
  };
  const remove = async () => {
    try {
      await api.deleteSecret(name);
      setIsSet(false);
      setShown("");
      toast("Removed.");
      onRemoved?.();
    } catch (e) {
      toast(errorParts(e).message);
    }
  };
  const placeholder = isSet
    ? `${shown || "••••"} (saved)`
    : multiline
      ? "paste here"
      : "paste the token";
  return (
    <div className="ss-label">
      <label htmlFor={id}>
        {label} <span className="ss-mono ss-meta">{name}</span>
      </label>
      <span className="ss-actions">
        {multiline ? (
          <textarea
            id={id}
            className="ss-input mono"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            rows={3}
            aria-invalid={!!err}
            style={{ flex: "1 1 220px" }}
          />
        ) : (
          <input
            type="password"
            id={id}
            className="ss-input mono"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="off"
            placeholder={placeholder}
            aria-invalid={!!err}
            style={{ flex: "1 1 200px" }}
            onKeyDown={(e) => e.key === "Enter" && void save()}
          />
        )}
        <button
          className="ss-btn sm"
          type="button"
          onClick={save}
          disabled={!value.trim()}
          style={{ minHeight: 40 }}
        >
          Save
        </button>
        {isSet && (
          <button
            className="ss-btn sm q"
            type="button"
            onClick={remove}
            style={{ minHeight: 40 }}
          >
            Remove
          </button>
        )}
      </span>
      {err && (
        <Note tone="err" role="alert">
          {err}
        </Note>
      )}
      <span className="ss-help">
        {how ? `${how} ` : ""}Stored encrypted in keel's database; only the last
        characters are shown.
      </span>
    </div>
  );
}

function LoginHelper({
  p,
  onClose,
  onSaved,
}: {
  p: Conn;
  onClose: () => void;
  onSaved: () => void;
}) {
  const h = HELP[p.id];
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const adapter: LoginAdapter<LoginView> = {
    start: () => {
      setTest(null);
      setCode("");
      return api.startLogin(p.id);
    },
    poll: (id) => api.login(id),
    cancel: (id) => api.cancelLogin(id),
  };
  // when it is saved: refresh the page behind and run the test once
  const done = () => {
    onSaved();
    if (p.selected !== "api") {
      api.testConnection(p.id).then(
        (r) =>
          live.current &&
          setTest({
            ok: r.ok,
            text: r.ok
              ? `${r.text ?? "OK"} · ${(r.ms / 1000).toFixed(1)}s`
              : (r.error ?? "no answer"),
          }),
        (e) =>
          live.current && setTest({ ok: false, text: errorParts(e).message }),
      );
    }
  };
  const send = async ({
    login,
    setLogin,
    setErr,
    sent,
  }: LoginCtx<LoginView>) => {
    if (!login || !code.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      sent();
      setLogin(await api.loginCode(login.id, code.trim()));
      setCode("");
    } catch (e) {
      setErr(errorParts(e).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <LoginDrawer
      title={`Set up ${h.name} login`}
      intro={h.here}
      adapter={adapter}
      doneText={(v) => `${v.message} (${v.hint ?? "saved"})`}
      onDone={done}
      onClose={onClose}
      openTitle={h.open}
      codeStep={
        p.id === "claude"
          ? (ctx) =>
              (
                <div className="ss-label">
                  <label htmlFor="login-code">
                    After you sign in, the page shows a code. Paste it here:
                  </label>
                  <span className="ss-actions">
                    <input
                      id="login-code"
                      type="text"
                      className="ss-input mono"
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      autoComplete="off"
                      placeholder="code from the Claude page"
                      style={{ flex: "1 1 220px", minHeight: 48, fontSize: 15 }}
                      onKeyDown={(e) => e.key === "Enter" && void send(ctx)}
                    />
                    <button
                      className="ss-btn p"
                      type="button"
                      style={{ minHeight: 48 }}
                      onClick={() => void send(ctx)}
                      disabled={busy || !code.trim()}
                    >
                      Send
                    </button>
                  </span>
                  <span className="ss-help">
                    Use the link from this box; a code from an older tab will
                    not work.
                  </span>
                </div>
              )
          : undefined
      }
      status={
        test && (
          <p
            role="status"
            className="ss-small"
            style={{ margin: 0, color: test.ok ? "var(--ok)" : "var(--bad)" }}
          >
            {test.ok ? "Test: " : "Test failed: "}
            {test.text}
          </p>
        )
      }
      paste={(saved) => (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <ol
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
              margin: 0,
              paddingLeft: 20,
            }}
          >
            {h.paste.steps.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ol>
          {h.paste.link && (
            <a
              className="ss-btn sm"
              style={{ alignSelf: "flex-start" }}
              href={h.paste.link[0]}
              target="_blank"
              rel="noreferrer"
            >
              {h.paste.link[1]} <span aria-hidden="true">↗</span>
            </a>
          )}
          {p.login_secret && (
            <SecretField
              id={`helper-${p.id}`}
              name={p.login_secret}
              label={LOGIN_HELP[p.id]?.label ?? "Login"}
              how=""
              set={!!p.login_set}
              hint={p.login_hint}
              multiline={LOGIN_HELP[p.id]?.multiline}
              onSaved={(hint) => {
                saved(`${h.name} login saved${hint ? ` (${hint})` : ""}`);
                done();
              }}
            />
          )}
        </div>
      )}
    />
  );
}

function ProviderRow({
  p,
  open,
  onToggle,
  onChanged,
  fake = [],
}: {
  p: Conn;
  open: boolean;
  onToggle: (open: boolean) => void;
  onChanged: () => void;
  fake?: string[];
}) {
  const { toast } = useApp();
  const [key, setKey] = useState("");
  const [hint, setHint] = useState(p.key_hint ?? "");
  const [keySet, setKeySet] = useState(p.key_set);
  const [mode, setMode] = useState<Mode>(p.selected);
  const [test, setTest] = useState<{ ok?: boolean; text: string } | null>(null);
  const [helper, setHelper] = useState(false);
  const catalog = useCatalog();
  useEffect(() => {
    setKeySet(p.key_set);
    setHint(p.key_hint ?? "");
    setMode(p.selected);
  }, [p.key_set, p.key_hint, p.selected]);
  // The model "Use for all agents" sets: this provider, the mode picked above, a model and effort from the catalog.
  const [allModel, setAllModel] = useState<Model | null>(null);
  const forAll: Model =
    allModel && allModel.mode === mode
      ? allModel
      : defaultModel(catalog, p.id, mode);
  const secret = SECRET[p.id];
  const state = connState({ ...p, selected: mode, key_set: keySet });
  const name = HELP[p.id]?.name ?? NAME[p.id] ?? p.label;
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
  const removeKey = async () => {
    if (!secret) return;
    try {
      await api.deleteSecret(secret);
      setKeySet(false);
      setHint("");
      toast("Key removed.");
    } catch (e) {
      toast(errorParts(e).message);
    }
  };
  const useForAll = async () => {
    const m: Model = {
      ...forAll,
      provider: p.id,
      mode,
      model: forAll.model.trim() || defaultModel(catalog, p.id, mode).model,
    };
    try {
      await api.saveGeneralSettings({
        default_model: m,
        implementer_model: m,
        reviewer_model: m,
      });
      toast(
        `All agents now use ${p.label} ${m.model}${m.effort ? ` (${m.effort})` : ""} · ${p.modes.find((x) => x.id === mode)?.label ?? modeLabel(p.id, mode)}. Change single agents in Agents.`,
      );
      onChanged();
    } catch (e) {
      toast(errorParts(e).message);
    }
  };
  const runTest = async () => {
    setTest({ text: "sending “Reply with exactly: OK”…" });
    try {
      const r = await api.testConnection(p.id);
      setTest(
        r.ok
          ? {
              ok: true,
              text: `${r.text ?? "OK"} · ${(r.ms / 1000).toFixed(1)}s`,
            }
          : { ok: false, text: r.error ?? "no answer" },
      );
    } catch (e) {
      const er = errorParts(e);
      setTest({
        ok: false,
        text: er.hint ? `${er.message} ${er.hint}` : er.message,
      });
    }
  };
  // "Add the key" / "Set up": open the row and put the cursor where the key or the setup goes
  const focusIn = (sel: string) => {
    onToggle(true);
    window.setTimeout(
      () => document.querySelector<HTMLElement>(sel)?.focus(),
      0,
    );
  };
  const head = `conn-${p.id}`;
  const loginAct = HELP[p.id]
    ? p.login_set
      ? "Log in again"
      : "Set up login"
    : null;
  const keyAct =
    state.need === "key" && secret
      ? "Add the key"
      : state.need === "key" && CONFIGURED.has(p.id)
        ? "Set up"
        : null;
  return (
    <div
      className={`ss-prow${open ? " open" : ""}`}
      data-testid={`conn-${p.id}`}
      role="group"
      aria-labelledby={head}
    >
      {helper && (
        <LoginHelper
          p={p}
          onClose={() => setHelper(false)}
          onSaved={onChanged}
        />
      )}
      <div className="ss-row0">
        <Tile>{name[0]}</Tile>
        <button
          type="button"
          className="ss-pname"
          aria-expanded={open}
          aria-controls={`${head}-b`}
          onClick={() => onToggle(!open)}
        >
          <b id={head}>{name}</b>
          <span className="ss-meta">{USE[p.id] ?? p.label}</span>
        </button>
        <span className="ss-pstate">
          <TonePill tone={PILL_TONE[state.tone] ?? "off"}>
            {state.text}
          </TonePill>
          {test && (
            <span role="status" className="ss-small" style={{ fontSize: 13 }}>
              {test.ok === true ? (
                <b style={{ color: "var(--ok)", fontWeight: 600 }}>Test OK</b>
              ) : test.ok === false ? (
                <b style={{ color: "var(--bad)", fontWeight: 600 }}>
                  Test failed
                </b>
              ) : null}{" "}
              <span className="ss-meta">{test.text}</span>
            </span>
          )}
        </span>
        <span className="ss-push">
          {loginAct && (
            <button
              className={`ss-btn sm${state.need === "login" ? " p" : ""}`}
              type="button"
              onClick={() => setHelper(true)}
            >
              {loginAct}
            </button>
          )}
          {keyAct && (
            <button
              className="ss-btn sm p"
              type="button"
              onClick={() =>
                focusIn(
                  secret
                    ? `#key-${p.id}`
                    : `#conn-${p.id}-setup input, #conn-${p.id}-setup button`,
                )
              }
            >
              {keyAct}
            </button>
          )}
          <button className="ss-btn sm" type="button" onClick={runTest}>
            Test
          </button>
          <button
            type="button"
            className="ss-arrow"
            aria-label={`${open ? "Close" : "Open"} ${name}`}
            aria-expanded={open}
            aria-controls={`${head}-b`}
            onClick={() => onToggle(!open)}
          >
            {open ? "▾" : "▸"}
          </button>
        </span>
        {state.need === "login" && (
          <Note tone="warn" className="ss-full">
            keel has no {name} login yet, so its agents cannot use your
            subscription. Set up login signs in from here, or paste a token.
          </Note>
        )}
        {state.need === "opencode" && (
          <Note tone="warn" className="ss-full">
            OpenCode has no GitHub Copilot login yet, so its agents cannot run.
            Run <code>opencode auth login</code> inside keel's container (for
            example <code>docker exec -it keel-v2 opencode auth login</code>),
            then press Test.
          </Note>
        )}
        {state.need === "cli" && (
          <Note tone="warn" className="ss-full">
            The {p.modes.find((x) => x.id === mode)?.label ?? "CLI"} is not
            installed in keel's image. Pick another way below, or build the
            image with INSTALL_CLIS=1.
          </Note>
        )}
        {p.id !== "fake" &&
          fake.length > 0 &&
          state.tone === "ok" &&
          (p.login_set || keySet) && (
            <Note tone="info" role="note" className="ss-full">
              {name} is {p.login_set ? "logged in" : "ready"}, but{" "}
              {fake.join(", ")} still use{fake.length === 1 ? "s" : ""} the fake
              model, so those agents do no real work.{" "}
              <button className="ss-btn sm p" type="button" onClick={useForAll}>
                Use {p.label} for all agents
              </button>
            </Note>
          )}
      </div>
      {open && (
        <div className="ss-prow-b" id={`${head}-b`}>
          <fieldset
            style={{
              flex: "1 1 280px",
              display: "flex",
              flexDirection: "column",
              gap: 8,
              margin: 0,
              padding: 0,
              border: 0,
            }}
          >
            <legend
              style={{ padding: "0 0 8px", fontSize: 13, fontWeight: 500 }}
            >
              How agents reach {name}
            </legend>
            <RadioCards
              label={`How agents reach ${name}`}
              value={mode}
              onChange={(m) => void pick(m)}
              options={p.modes.map((m) => ({
                id: m.id,
                title: m.label,
                sub: m.detail,
                side: (
                  <span style={{ color: m.ready ? "var(--ok)" : "var(--dim)" }}>
                    {m.ready ? "ready" : "not ready"}
                  </span>
                ),
              }))}
            />
          </fieldset>
          <div
            style={{
              flex: "1 1 300px",
              display: "flex",
              flexDirection: "column",
              gap: 16,
            }}
          >
            {CONFIGURED.has(p.id) && (
              <div id={`conn-${p.id}-setup`}>
                {p.id === "local" ? (
                  <LocalServers onChanged={onChanged} />
                ) : (
                  <VertexSettings onChanged={onChanged} />
                )}
              </div>
            )}
            {p.login_secret && LOGIN_HELP[p.id] && (
              <SecretField
                id={`login-${p.id}`}
                name={p.login_secret}
                label={LOGIN_HELP[p.id].label}
                how={LOGIN_HELP[p.id].how}
                set={!!p.login_set}
                hint={p.login_hint}
                multiline={LOGIN_HELP[p.id].multiline}
                onSaved={onChanged}
                onRemoved={onChanged}
              />
            )}
            {secret && (
              <div className="ss-label">
                <label htmlFor={`key-${p.id}`} className="ss-mono">
                  {secret}
                </label>
                <span className="ss-actions">
                  <input
                    type="password"
                    id={`key-${p.id}`}
                    className="ss-input mono"
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    autoComplete="off"
                    placeholder={
                      keySet ? `${hint || "••••"} (saved)` : "paste the key"
                    }
                    style={{ flex: "1 1 200px" }}
                    onKeyDown={(e) => e.key === "Enter" && void saveKey()}
                  />
                  <button
                    className="ss-btn sm"
                    type="button"
                    onClick={saveKey}
                    disabled={!key.trim()}
                    style={{ minHeight: 40 }}
                  >
                    Save
                  </button>
                  {keySet && (
                    <button
                      className="ss-btn sm q"
                      type="button"
                      onClick={removeKey}
                      style={{ minHeight: 40 }}
                    >
                      Remove
                    </button>
                  )}
                </span>
                <span className="ss-help">
                  For the API key way. Stored encrypted; only the last
                  characters are shown. Subscription mode removes it from the
                  CLI's environment.
                </span>
              </div>
            )}
            {p.id !== "fake" && (
              <div
                className="ss-label"
                role="group"
                aria-labelledby={`all-${p.id}-lab`}
              >
                <span id={`all-${p.id}-lab`}>Model for all agents</span>
                <span className="ss-actions">
                  <ModelPicker
                    id={`all-${p.id}`}
                    value={forAll}
                    onChange={setAllModel}
                    provider={false}
                    mode={false}
                  />
                  <button
                    className="ss-btn sm"
                    type="button"
                    onClick={useForAll}
                  >
                    Use for all agents
                  </button>
                </span>
                <span className="ss-help">
                  Sets the default, implementer and reviewer model, on the way
                  chosen here.
                </span>
              </div>
            )}
            {p.id !== "fake" && <UsageLine provider={p.id} />}
          </div>
        </div>
      )}
    </div>
  );
}

/** Known providers in the order the page shows them; a row shows at once and fills in when the check answers. */
const ORDER = ["claude", "codex", "copilot", "vertex", "local", "fake"];
const order = (a: Conn, b: Conn) =>
  (ORDER.indexOf(a.id) + 1 || 99) - (ORDER.indexOf(b.id) + 1 || 99);

function CheckingRow({ id }: { id: string }) {
  return (
    <div className="ss-prow" aria-busy="true" data-testid={`conn-${id}`}>
      <div className="ss-row0">
        <Tile>{(NAME[id] ?? id)[0]}</Tile>
        <span className="ss-grow">
          <b style={{ fontWeight: 600 }}>{NAME[id] ?? id}</b>
          <span className="ss-meta">{USE[id]}</span>
        </span>
        <span className="ss-pstate">
          <Spinner>Checking</Spinner>
        </span>
      </div>
    </div>
  );
}

/** The model rows: each kind of agent, and whether this project's agents run on local models only. */
export const MODEL_ROWS: Row[] = [
  {
    key: "default_model",
    label: "Default model",
    kind: { t: "model" },
    help: "Every agent that has no model of its own.",
  },
  {
    key: "implementer_model",
    label: "Implementer model",
    kind: { t: "model" },
    help: "Writes the code that makes a failing test pass.",
  },
  {
    key: "reviewer_model",
    label: "Reviewer model",
    kind: { t: "model" },
    help: "Reviews each criterion and the whole branch.",
  },
  {
    key: "cheaper_model",
    label: "Cheaper model",
    kind: { t: "model" },
    warn: (v) => (v as Model | undefined)?.provider === "fake",
    help: (v) =>
      (v as Model | undefined)?.provider === "fake"
        ? "Not set: the fake model never runs a real flow, so keel pauses and asks instead. Claude Haiku is the usual choice."
        : "Used only when a cap or a plan window is nearly used and you choose to switch. Claude Haiku by default.",
  },
  {
    key: "local_only",
    label: "Local models only",
    def: false,
    kind: { t: "bool", on: "yes", off: "no" },
    help: (v) =>
      v === true
        ? "This project's agents, KeelBot and the review check run only on local models: keel refuses a cloud model, so the code stays on your machines."
        : "Any model may run this project's agents. Turn it on for code that may not leave your machines (local models: Local models above).",
  },
];

/** A model and its effort: the model's dropdown (grouped by provider, with how it runs) and the effort as a choice. */
function ModelControl({
  id,
  value,
  onSave,
}: {
  id: string;
  value: Model;
  onSave: (m: Model) => void;
}) {
  const catalog = useCatalog();
  const efforts = value
    ? effortsOf(catalog, value.provider, value.mode, value.model)
    : [];
  return (
    <span className="ss-model">
      <ModelPicker id={id} value={value} onChange={onSave} effort={false} />
      {efforts.length > 0 && (
        <Seg
          label="Effort"
          value={value.effort ?? ""}
          onChange={(e) =>
            onSave(
              e
                ? { ...value, effort: e }
                : {
                    provider: value.provider,
                    mode: value.mode,
                    model: value.model,
                  },
            )
          }
          options={[
            ["", "default"],
            ...efforts.map((x) => [x, x] as [string, string]),
          ]}
        />
      )}
    </span>
  );
}

export function ModelsTab({ pid }: { pid: string }) {
  const { project } = useApp();
  const name = project?.name ?? pid;
  const conns = useLoad("connections", () => api.connections(), {
    live: false,
  });
  const s = useScopedSettings(pid, name);
  const fake = fakeAgents(
    s.general.data as Partial<Record<string, unknown>> | null,
  );
  const c = conns.data;
  const providers = c ? [...c.providers].sort(order) : null;
  const missing =
    providers?.filter((p) => {
      const st = connState(p);
      return st.need === "login" || (st.need === "key" && !!SECRET[p.id]);
    }).length ?? 0;
  const firstNeed = providers?.find((p) => connState(p).need)?.id ?? "";
  const [opened, setOpened] = useStored<string | null>(
    "keel2.settings.provider",
    null,
  );
  const open = opened ?? firstNeed;
  useEffect(() => {
    if (providers) setSettingsHint("models", missing ? String(missing) : null);
  }, [providers, missing]);
  const changed = () => {
    void conns.reload();
    void s.general.reload();
    if (pid) void s.proj.reload();
  };
  return (
    <SettingsFrame
      tab="models"
      title="Models & logins"
      line="Which accounts the agents use, which model each kind of agent runs on, and what is installed. Keys are encrypted and never shown again in full."
    >
      {conns.error && (
        <ErrorBox error={conns.error} onRetry={() => void conns.reload()} />
      )}
      <section className="ss-list" aria-labelledby="m-acc">
        <div className="ss-row0" style={{ padding: "16px 20px" }}>
          <div className="ss-grow">
            <h2 id="m-acc" className="ss-h2">
              Providers
            </h2>
            <p
              className="ss-sub"
              style={missing ? { color: "var(--warn)" } : undefined}
            >
              {!providers
                ? "Checking each provider: which CLIs are installed and which logins and keys are saved."
                : missing
                  ? `${missing} provider${missing === 1 ? " needs" : "s need"} a login or a key before its agents can run.`
                  : "Every provider is ready."}
            </p>
          </div>
        </div>
        {providers
          ? providers.map((p) => (
              <ProviderRow
                key={p.id}
                p={p}
                fake={fake}
                open={open === p.id}
                onToggle={(o) => setOpened(o ? p.id : "")}
                onChanged={changed}
              />
            ))
          : !conns.error && ORDER.map((id) => <CheckingRow key={id} id={id} />)}
        {providers && !providers.length && (
          <div className="ss-row">
            <EmptyState title="No provider known">
              The keel api lists none. Update keel and reload.
            </EmptyState>
          </div>
        )}
      </section>

      <section className="ss-list" aria-labelledby="m-roles">
        <div className="ss-row0" style={{ padding: "16px 20px" }}>
          <div className="ss-grow">
            <h2 id="m-roles" className="ss-h2">
              Models
            </h2>
            <p className="ss-sub">
              Which model each kind of agent runs on. One agent can still use
              its own (<a href="#/agents">Agents page</a>).
            </p>
          </div>
        </div>
        {s.general.error ? (
          <div className="ss-row">
            <ErrorBox
              error={s.general.error}
              onRetry={() => void s.general.reload()}
            />
          </div>
        ) : (
          <div style={{ padding: "0 20px" }}>
            {MODEL_ROWS.map((row) => (
              <GeneralRow
                key={row.key}
                row={row}
                s={s}
                projectName={name}
                control={
                  row.kind.t === "model"
                    ? (v, save) => (
                        <ModelControl
                          id={`set-${row.key}`}
                          value={v as Model}
                          onSave={save}
                        />
                      )
                    : undefined
                }
              />
            ))}
          </div>
        )}
      </section>

      <section className="ss-cardp" aria-labelledby="m-machine">
        <div>
          <h2 id="m-machine" className="ss-h2">
            This machine
          </h2>
          <p className="ss-sub">
            Programs keel and its agents find in the container.
          </p>
        </div>
        <div className="ss-chipline" aria-label="Installed programs">
          {c ? (
            c.machine.map((m) => (
              <span key={m.name} className={`ss-tag check${m.ok ? "" : " no"}`}>
                <span aria-hidden="true">{m.ok ? "✓" : "!"}</span> {m.name}
                {m.version ? (
                  <span className="ss-mono ss-small">{m.version}</span>
                ) : !m.ok ? (
                  <span className="ss-small">not installed</span>
                ) : null}
              </span>
            ))
          ) : !conns.error ? (
            <Spinner>Checking what is installed</Spinner>
          ) : (
            <span className="ss-meta">Not checked.</span>
          )}
        </div>
      </section>
    </SettingsFrame>
  );
}
