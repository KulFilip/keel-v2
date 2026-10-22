import { useState } from "react";
import { refreshFeatures } from "../../addons";
import { errorParts } from "../../api";
import { ErrorBox, Loading, Panel } from "../../components/ui";
import { clock } from "../../format";
import {
  liveNotes,
  loadsWeb,
  marketApi,
  sourceStatusOf,
  sourcesOf,
  type ChangeAnswer,
  type Rules,
  type Source,
} from "../../marketplaceApi";
import { useApp, useLoad } from "../../state";
import { type Err } from "../PluginDetail";

// ---------- Sources and rules ----------

const RULES: [keyof Rules, string, string][] = [
  [
    "agents_may_ask",
    "Agents may ask to install plugins",
    "KeelBot and flow agents send a request to the Inbox. Nothing installs until a person approves it.",
  ],
  [
    "check_daily",
    "Check for updates every day",
    "Updates never install by themselves. An update that asks for more permissions always asks you.",
  ],
  [
    "allow_unverified",
    "Allow unverified publishers",
    "Off: plugins with pages or code install only from publishers a catalog you trust has verified.",
  ],
  [
    "restart_when_idle",
    "Restart by itself after an approved install",
    "keel waits until no agent step runs, then restarts to load the new plugin.",
  ],
];

const shortKey = (k?: string) =>
  !k ? "—" : k.length > 16 ? `${k.slice(0, 8)}…${k.slice(-6)}` : k;
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "catalog";

export function SourcesTab({ onChanged }: { onChanged: () => void }) {
  const { toast } = useApp();
  const src = useLoad("plugin-sources", () => marketApi.sources());
  const status = useLoad("plugin-source-status", () => marketApi.search(), {
    live: false,
  });
  const rules = useLoad("plugin-rules", () => marketApi.rules());
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [file, setFile] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState<Err>(null);
  const sources = sourcesOf(src.data);
  const statusOf = (id: string) =>
    sourceStatusOf(status.data).find((s) => s.id === id);

  const run = async (
    what: string,
    fn: () => Promise<unknown>,
    done: string | ((answer: unknown) => string),
  ) => {
    setBusy(what);
    setErr(null);
    try {
      const answer = await fn();
      toast(typeof done === "string" ? done : done(answer));
      return true;
    } catch (e) {
      setErr(errorParts(e));
      return false;
    } finally {
      setBusy("");
    }
  };
  const save = (list: Source[], done: string) =>
    run(
      "sources",
      async () => src.setData(await marketApi.saveSources(list)),
      done,
    );
  const add = async () => {
    const u = url.trim();
    let host = "";
    try {
      host = new URL(u).host;
    } catch {
      /* the api says what is wrong */
    }
    const name = title.trim() || host || u;
    const base = slug(title.trim() || host.split(".")[0] || "catalog");
    let id = base;
    for (let n = 2; sources.some((s) => s.id === id); n++) id = `${base}-${n}`;
    if (
      await save(
        [...sources, { id, title: name, url: u, key: key.trim(), on: true }],
        `${name} is added. keel reads it now.`,
      )
    ) {
      setTitle("");
      setUrl("");
      setKey("");
      await run(
        "refresh",
        () => marketApi.refresh(),
        "The catalogs are read again.",
      );
      await status.reload();
    }
  };
  const refresh = async () => {
    if (
      await run(
        "refresh",
        () => marketApi.refresh(),
        "The catalogs are read again.",
      )
    )
      await Promise.all([src.reload(), status.reload()]);
  };
  const setRule = async (k: keyof Rules, on: boolean) => {
    if (!rules.data) return;
    const next = { ...rules.data, [k]: on };
    await run(
      "rules",
      async () => rules.setData(await marketApi.saveRules(next)),
      "Saved.",
    );
  };
  const fromFile = async () => {
    if (
      await run(
        "file",
        () => marketApi.installFile(file.trim()),
        (answer) => {
          const a = answer as ChangeAnswer | null;
          const applied =
            !!a?.live &&
            !Object.values(liveNotes(a)).includes("restart") &&
            !!a.live.applied?.length;
          if (loadsWeb(a)) void refreshFeatures();
          return applied
            ? "The file is installed, as unsigned. It works now."
            : "The file is installed, as unsigned. Restart keel to use it.";
        },
      )
    ) {
      setFile("");
      onChanged();
    }
  };

  return (
    <div className="mk-g2">
      <div className="grid">
        {err && <ErrorBox error={err} />}
        <Panel
          title="Catalogs"
          extra={
            <div className="row">
              <span className="sub">Each catalog is signed</span>
              <button
                className="btn sm"
                type="button"
                disabled={busy === "refresh"}
                onClick={() => void refresh()}
              >
                {busy === "refresh" ? "Reading…" : "Refresh"}
              </button>
            </div>
          }
        >
          {src.error && !src.data ? (
            <ErrorBox error={src.error} onRetry={() => void src.reload()} />
          ) : !src.data ? (
            <Loading what="Reading the catalogs" />
          ) : (
            <ul className="mk-sources" aria-label="Catalogs">
              {sources.map((s) => {
                const st = statusOf(s.id);
                const problem = st?.problem ?? s.problem;
                const official = s.official || s.id === "keel";
                return (
                  <li key={s.id} className="mk-source">
                    <div className="mk-source-t">
                      <b>{s.title || s.id}</b>{" "}
                      {official && <span className="tag keel">built in</span>}
                      <div className="sub mono mk-url">{s.url}</div>
                      <div className="sub">
                        Key <span className="mono">{shortKey(s.key)}</span>
                        {st?.old ? " · the copy is old" : ""}
                        {st?.ok
                          ? s.fetched_at
                            ? ` · read at ${clock(s.fetched_at, false)}`
                            : " · read"
                          : ""}
                        {typeof s.plugins === "number"
                          ? ` · ${s.plugins} plugin${s.plugins === 1 ? "" : "s"}`
                          : ""}
                      </div>
                      {problem && <div className="mk-warn">{problem}</div>}
                    </div>
                    <div className="row">
                      <input
                        type="checkbox"
                        role="switch"
                        className="mk-sw"
                        aria-label={`${s.title || s.id} on`}
                        checked={s.on !== false}
                        disabled={busy === "sources"}
                        onChange={(e) =>
                          void save(
                            sources.map((x) =>
                              x.id === s.id
                                ? { ...x, on: e.target.checked }
                                : x,
                            ),
                            e.target.checked
                              ? `${s.title || s.id} is on.`
                              : `${s.title || s.id} is off.`,
                          )
                        }
                      />
                      {!official && (
                        <button
                          className="btn sm ghost"
                          type="button"
                          disabled={busy === "sources"}
                          onClick={() =>
                            void save(
                              sources.filter((x) => x.id !== s.id),
                              `${s.title || s.id} is removed.`,
                            )
                          }
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <form
            className="mk-add"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
            aria-label="Add a catalog"
          >
            <div className="field">
              <label htmlFor="mk-src-title">Name</label>
              <input
                id="mk-src-title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Acme catalog"
              />
            </div>
            <div className="field">
              <label htmlFor="mk-src-url">Catalog URL</label>
              <input
                id="mk-src-url"
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://…/v1/index.json"
              />
            </div>
            <div className="field">
              <label htmlFor="mk-src-key">Its public key</label>
              <input
                id="mk-src-key"
                type="text"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="RWQ…"
              />
            </div>
            <div className="row">
              <button
                className="btn"
                type="submit"
                disabled={!url.trim() || !key.trim() || busy === "sources"}
              >
                Add the catalog
              </button>
            </div>
          </form>
        </Panel>
        <Panel title="For plugin authors">
          <p className="sub" style={{ marginTop: 0 }}>
            Install a .kplug file you built, from a path in /data. keel shows it
            as <b>unsigned</b>.
          </p>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void fromFile();
            }}
          >
            <label htmlFor="mk-file" className="sr-only">
              The file's path in /data
            </label>
            <input
              id="mk-file"
              type="text"
              className="inline-input"
              style={{ flex: "1 1 240px" }}
              value={file}
              onChange={(e) => setFile(e.target.value)}
              placeholder="/data/my-plugin-0.1.0.kplug"
            />
            <button
              className="btn"
              type="submit"
              disabled={!file.trim() || busy === "file"}
            >
              {busy === "file" ? "Installing…" : "Install the file"}
            </button>
          </form>
        </Panel>
      </div>
      <Panel title="Rules">
        {rules.error && !rules.data ? (
          <ErrorBox error={rules.error} onRetry={() => void rules.reload()} />
        ) : !rules.data ? (
          <Loading what="Reading the rules" />
        ) : (
          <div className="grid mk-rules">
            {RULES.map(([k, label, about]) => (
              <label key={k} className="chk mk-rule">
                <input
                  type="checkbox"
                  checked={Boolean(rules.data![k])}
                  disabled={busy === "rules"}
                  onChange={(e) => void setRule(k, e.target.checked)}
                />
                <span>
                  <b>{label}</b>
                  <br />
                  <span className="sub">{about}</span>
                </span>
              </label>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
