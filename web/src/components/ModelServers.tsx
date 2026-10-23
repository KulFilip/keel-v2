// 0.18.46 The settings of the two providers whose connection is more than one key (Connections, inside their cards):
// local model servers (Ollama, LM Studio, vLLM, llama.cpp, any OpenAI-compatible URL) and Google Vertex AI. Keys are
// saved encrypted and never come back: a saved one shows only its last characters (a server) or its account (Vertex).

import { useEffect, useState } from "react";
import {
  api,
  errorParts,
  type LocalEndpoint,
  type LocalModels,
  type LocalServerKind,
  type LocalTest,
  type VertexView,
} from "../api";
import { resetProviderModels } from "./ModelPicker";
import { useApp } from "../state";

export const KIND_LABEL: Record<LocalServerKind, string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  vllm: "vLLM",
  llamacpp: "llama.cpp server",
  "openai-compatible": "OpenAI-compatible URL",
};
const KIND_HINT: Record<LocalServerKind, string> = {
  ollama:
    "The Ollama address without /v1. keel lists its models and reads what each can do.",
  lmstudio: "LM Studio's server (Developer › Start server), with /v1.",
  vllm: "vllm serve …, with /v1.",
  llamacpp: "llama-server, with /v1.",
  "openai-compatible":
    "Any server with /chat/completions and /models under this URL.",
};
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

type Draft = {
  name: string;
  kind: LocalServerKind;
  url: string;
  key: string;
  context: string;
  price_in: string;
  price_out: string;
};
const num = (s: string) => (s.trim() === "" ? null : Number(s));

function EndpointForm({
  start,
  defaults,
  onSaved,
  onCancel,
  isNew,
}: {
  start: Draft;
  defaults: Record<string, string>;
  onSaved: (v: LocalModels) => void;
  onCancel: () => void;
  isNew: boolean;
}) {
  const { toast } = useApp();
  const [d, setD] = useState<Draft>(start);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set =
    (k: keyof Draft) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setD({ ...d, [k]: e.target.value });
  const id = `ls-${isNew ? "new" : start.name}`;
  const nameOk = NAME.test(d.name);
  const save = async () => {
    if (!nameOk)
      return setErr(
        "A name has lower-case letters, digits and dashes, for example ollama.",
      );
    setBusy(true);
    setErr(null);
    try {
      const v = await api.saveLocalEndpoint(d.name, {
        kind: d.kind,
        url: d.url.trim(),
        ...(d.key.trim() ? { key: d.key.trim() } : {}),
        context: num(d.context),
        price_in: num(d.price_in),
        price_out: num(d.price_out),
      });
      resetProviderModels();
      toast(`Saved ${d.name}.`);
      onSaved(v);
    } catch (e) {
      const er = errorParts(e);
      setErr(er.hint ? `${er.message} ${er.hint}` : er.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ls-form" data-testid={`${id}-form`}>
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        <div className="field">
          <label htmlFor={`${id}-name`}>Name</label>
          <input
            id={`${id}-name`}
            value={d.name}
            onChange={set("name")}
            disabled={!isNew}
            placeholder="ollama"
            style={{ width: 130 }}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-kind`}>Server</label>
          <select
            id={`${id}-kind`}
            value={d.kind}
            onChange={(e) => {
              const kind = e.target.value as LocalServerKind;
              // a URL still at the old kind's default follows the new kind
              const url =
                !d.url || d.url === defaults[d.kind]
                  ? (defaults[kind] ?? "")
                  : d.url;
              setD({ ...d, kind, url });
            }}
          >
            {(Object.keys(KIND_LABEL) as LocalServerKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ flex: "1 1 260px" }}>
          <label htmlFor={`${id}-url`}>URL</label>
          <input
            id={`${id}-url`}
            value={d.url}
            onChange={set("url")}
            placeholder={defaults[d.kind] || "http://…/v1"}
            spellCheck={false}
          />
        </div>
      </div>
      <span className="hint">{KIND_HINT[d.kind]}</span>
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        <div className="field" style={{ flex: "1 1 200px" }}>
          <label htmlFor={`${id}-key`}>Key (optional)</label>
          <input
            id={`${id}-key`}
            type="password"
            value={d.key}
            onChange={set("key")}
            autoComplete="off"
            placeholder={
              start.key
                ? ""
                : isNew
                  ? "only if the server asks for one"
                  : "leave empty to keep the saved one"
            }
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-ctx`}>Context (tokens)</label>
          <input
            id={`${id}-ctx`}
            inputMode="numeric"
            value={d.context}
            onChange={set("context")}
            placeholder="from the server"
            style={{ width: 130 }}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-pin`}>$ / M in</label>
          <input
            id={`${id}-pin`}
            inputMode="decimal"
            value={d.price_in}
            onChange={set("price_in")}
            placeholder="0"
            style={{ width: 80 }}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-pout`}>$ / M out</label>
          <input
            id={`${id}-pout`}
            inputMode="decimal"
            value={d.price_out}
            onChange={set("price_out")}
            placeholder="0"
            style={{ width: 80 }}
          />
        </div>
      </div>
      {err && (
        <div className="badc" role="alert">
          {err}
        </div>
      )}
      <div className="row">
        <button
          className="btn sm primary"
          type="button"
          onClick={save}
          disabled={busy || !d.url.trim() || !d.name}
        >
          Save
        </button>
        <button className="btn sm ghost" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function testText(r: LocalTest): string {
  if (!r.ok) return `${r.error ?? "no answer"}${r.hint ? ` ${r.hint}` : ""}`;
  const n = r.models?.length ?? 0;
  const names = (r.models ?? [])
    .slice(0, 4)
    .map((m) => m.id)
    .join(", ");
  return `${n} ${n === 1 ? "model" : "models"}${names ? `: ${names}${n > 4 ? ", …" : ""}` : ""} · ${(r.ms / 1000).toFixed(1)}s`;
}

function EndpointRow({
  e,
  defaults,
  onChanged,
}: {
  e: LocalEndpoint;
  defaults: Record<string, string>;
  onChanged: (v: LocalModels) => void;
}) {
  const { toast } = useApp();
  const [editing, setEditing] = useState(false);
  const [test, setTest] = useState<{ ok?: boolean; text: string } | null>(null);
  const runTest = async () => {
    setTest({ text: "asking the server…" });
    try {
      const r = await api.testLocalEndpoint(e.name);
      setTest({ ok: r.ok, text: testText(r) });
    } catch (x) {
      setTest({ ok: false, text: errorParts(x).message });
    }
  };
  const remove = async () => {
    try {
      onChanged(await api.deleteLocalEndpoint(e.name));
      resetProviderModels();
      toast(`Removed ${e.name}.`);
    } catch (x) {
      toast(errorParts(x).message);
    }
  };
  if (editing) {
    const start: Draft = {
      name: e.name,
      kind: e.kind,
      url: e.url,
      key: "",
      context: e.context ? String(e.context) : "",
      price_in: e.price_in != null ? String(e.price_in) : "",
      price_out: e.price_out != null ? String(e.price_out) : "",
    };
    return (
      <EndpointForm
        start={start}
        defaults={defaults}
        isNew={false}
        onCancel={() => setEditing(false)}
        onSaved={(v) => {
          setEditing(false);
          onChanged(v);
        }}
      />
    );
  }
  return (
    <li className="ls-row" data-testid={`ls-${e.name}`}>
      <div className="ls-id">
        <b>{e.name}</b>{" "}
        <span className="sub">{KIND_LABEL[e.kind] ?? e.kind}</span>{" "}
        <span className="mono sub">{e.url}</span>
        {e.key_set && (
          <span className="sub"> · key {e.key_hint ?? "saved"}</span>
        )}
        {e.context ? <span className="sub"> · {e.context} tokens</span> : null}
      </div>
      <div className="row">
        <button className="btn sm" type="button" onClick={runTest}>
          Test connection
        </button>
        <button
          className="btn sm ghost"
          type="button"
          onClick={() => setEditing(true)}
        >
          Edit
        </button>
        <button className="btn sm ghost" type="button" onClick={remove}>
          Remove
        </button>
      </div>
      {test && (
        <span className="hint" role="status" data-testid={`ls-${e.name}-test`}>
          {test.ok === true ? (
            <b className="okc">Reached</b>
          ) : test.ok === false ? (
            <b className="badc">Not reached</b>
          ) : null}{" "}
          {test.text}
        </span>
      )}
    </li>
  );
}

/** Connections › Local models: on/off, the servers, and a test per server. */
export function LocalServers({ onChanged }: { onChanged?: () => void }) {
  const { toast } = useApp();
  const [v, setV] = useState<LocalModels | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    let live = true;
    api.localModels().then(
      (r) => live && setV(r),
      (e) => live && setErr(errorParts(e).message),
    );
    return () => {
      live = false;
    };
  }, []);
  const changed = (n: LocalModels) => {
    setV(n);
    onChanged?.();
  };
  if (err) return <div className="badc">{err}</div>;
  if (!v) return <span className="hint">Loading the model servers…</span>;
  const toggle = async () => {
    try {
      changed(await api.setLocalModels(!v.enabled));
      resetProviderModels();
      toast(v.enabled ? "Local models are off." : "Local models are on.");
    } catch (e) {
      toast(errorParts(e).message);
    }
  };
  const first = !v.endpoints.length;
  const fresh: Draft = {
    name: first ? "ollama" : "",
    kind: "ollama",
    url: v.defaults.ollama ?? "",
    key: "",
    context: "",
    price_in: "",
    price_out: "",
  };
  return (
    <div className="field ls" data-testid="local-servers">
      <span className="lab">Model servers</span>
      {!first && (
        <label className="check-row">
          <input type="checkbox" checked={v.enabled} onChange={toggle} /> Offer
          local models to agents and KeelBot
        </label>
      )}
      {first && !adding && (
        <span className="hint">
          No server yet. Add Ollama, LM Studio, vLLM or a llama.cpp server
          running on this computer or your network.
        </span>
      )}
      {!first && (
        <ul className="ls-list">
          {v.endpoints.map((e) => (
            <EndpointRow
              key={e.name}
              e={e}
              defaults={v.defaults}
              onChanged={changed}
            />
          ))}
        </ul>
      )}
      {adding ? (
        <EndpointForm
          start={fresh}
          defaults={v.defaults}
          isNew
          onCancel={() => setAdding(false)}
          onSaved={(n) => {
            setAdding(false);
            changed(n);
          }}
        />
      ) : (
        <div className="row">
          <button
            className="btn sm"
            type="button"
            onClick={() => setAdding(true)}
          >
            Add a server
          </button>
        </div>
      )}
      <span className="hint">
        In Docker, this computer is{" "}
        <span className="mono">host.docker.internal</span>. A model that cannot
        call tools is offered only for KeelBot Ask, the review check and
        summaries. Use “Local models only” in a project’s Settings to keep its
        code on your machines.
      </span>
    </div>
  );
}

/** Connections › Vertex AI: project, region, and a service-account key (or Google's Application Default Credentials). */
export function VertexSettings({ onChanged }: { onChanged?: () => void }) {
  const { toast } = useApp();
  const [v, setV] = useState<VertexView | null>(null);
  const [project, setProject] = useState("");
  const [region, setRegion] = useState("global");
  const [json, setJson] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api.vertex().then(
      (r) => {
        if (!live) return;
        setV(r);
        setProject(r.project);
        setRegion(r.region || "global");
      },
      (e) => live && setErr(errorParts(e).message),
    );
    return () => {
      live = false;
    };
  }, []);
  const save = async (clear = false) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.saveVertex({
        project: project.trim(),
        region: region.trim(),
        ...(json.trim() ? { credentials_json: json.trim() } : {}),
        ...(clear ? { clear_credentials: true } : {}),
      });
      setV(r);
      setJson("");
      resetProviderModels();
      toast("Vertex AI saved.");
      onChanged?.();
    } catch (e) {
      const er = errorParts(e);
      setErr(er.hint ? `${er.message} ${er.hint}` : er.message);
    } finally {
      setBusy(false);
    }
  };
  if (!v && !err) return <span className="hint">Loading Vertex AI…</span>;
  return (
    <div className="field vx" data-testid="vertex-settings">
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        <div className="field">
          <label htmlFor="vx-project">Project id</label>
          <input
            id="vx-project"
            value={project}
            onChange={(e) => setProject(e.target.value)}
            placeholder="my-project-123"
            spellCheck={false}
          />
        </div>
        <div className="field">
          <label htmlFor="vx-region">Region</label>
          <input
            id="vx-region"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            placeholder="global"
            list="vx-regions"
            style={{ width: 150 }}
          />
          <datalist id="vx-regions">
            {[
              "global",
              "us",
              "eu",
              "us-east5",
              "us-central1",
              "europe-west1",
              "asia-southeast1",
            ].map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        </div>
      </div>
      <label htmlFor="vx-key">Service-account key (JSON)</label>
      <textarea
        id="vx-key"
        rows={3}
        value={json}
        onChange={(e) => setJson(e.target.value)}
        spellCheck={false}
        placeholder={
          v?.key_set
            ? `saved: ${v.client_email ?? "a service account"} (paste a new key to replace it)`
            : "paste the key file, or leave empty to use Application Default Credentials"
        }
      />
      <span className="hint">
        {v?.key_set ? (
          <>
            Signs in as <span className="mono">{v.client_email}</span>.
          </>
        ) : (
          "Without a key keel uses Google's Application Default Credentials."
        )}{" "}
        The account needs the Vertex AI User role, and Claude models must be
        enabled in the Model Garden. The key is stored encrypted and never shown
        again.
      </span>
      {err && (
        <div className="badc" role="alert">
          {err}
        </div>
      )}
      <div className="row">
        <button
          className="btn sm primary"
          type="button"
          onClick={() => void save()}
          disabled={busy || !project.trim() || !region.trim()}
        >
          Save
        </button>
        {v?.key_set && (
          <button
            className="btn sm ghost"
            type="button"
            onClick={() => void save(true)}
            disabled={busy}
          >
            Remove the key (use ADC)
          </button>
        )}
      </div>
    </div>
  );
}
