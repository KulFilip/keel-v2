// v0.17.1 a plugin that each project turns on (per_project: db, git, ci, review) is switched only in Control › Plugins
// (docs/plugins/22-one-plugins-page.md); Tools › Plugins is gone. The pieces:
//
//   ProjectSwitch   Installed's "This project: On/Off" under the keel-wide switch, and "For every project"
//   PluginAdds      what the plugin adds (KeelBot tools, workflow blocks, commands, where it shows): its page's About
//   PluginProjects  its page's Projects section: every project with its own switch, and "On for every project"
//
// They use the per-project api of v0.10.0: GET /api/projects/{pid}/plugins lists these plugins with enabled and scope
// (project: its own choice, all: every project's), PUT /api/projects/{pid}/plugins/{name} {enabled, scope} sets one.

import { useState } from "react";
import { api, errorParts, type Plugin } from "../api";
import { ErrorBox, Loading } from "../components/ui";
import { useApp, useLoad, type Loaded } from "../state";

const WHERE: Record<string, string> = {
  connections: "Connections",
  map: "Map › Query",
  code: "Code",
  workflows: "Workflows blocks",
  keelbot: "KeelBot",
  inbox: "Inbox",
  jobs: "Jobs",
  settings: "Settings",
};

/** The per-project plugins of the project chosen now (null key: no project yet, nothing is asked). */
export function useProjectPlugins(pid: string | null): Loaded<Plugin[]> {
  return useLoad(pid ? `plugins:${pid}` : null, () => api.plugins(pid!), {
    live: false,
  });
}

/** Turn a plugin on or off for one project ("project") or for every project ("all"), and say so. */
function useSwitch() {
  const { toast, projects } = useApp();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ message: string; hint?: string } | null>(
    null,
  );
  const nameOf = (pid: string) =>
    projects.find((x) => x.id === pid)?.name ?? pid;
  const set = async (
    pid: string,
    p: Pick<Plugin, "name" | "title">,
    enabled: boolean,
    scope: "project" | "all",
  ): Promise<Plugin[] | null> => {
    setBusy(true);
    setErr(null);
    try {
      const list = await api.setPlugin(pid, p.name, enabled, scope);
      toast(
        scope === "all"
          ? `${p.title} is ${enabled ? "on" : "off"} for every project.`
          : `${p.title} is ${enabled ? "on" : "off"} for ${nameOf(pid)}.`,
      );
      return list;
    } catch (e) {
      setErr(errorParts(e));
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { busy, err, set };
}

/** Installed: "This project: On" for the project chosen now, and "For every project". */
export function ProjectSwitch({
  pid,
  plugin,
  loaded,
}: {
  pid: string;
  plugin: Plugin;
  loaded: Loaded<Plugin[]>;
}) {
  const { project } = useApp();
  const { busy, err, set } = useSwitch();
  const name = project?.name ?? pid;
  const on = !!plugin.enabled;
  const every = on && plugin.scope === "all";
  const change = async (enabled: boolean, scope: "project" | "all") => {
    const list = await set(pid, plugin, enabled, scope);
    if (list) loaded.setData(list);
  };
  return (
    <div className="mk-proj">
      <label className="mk-projsw" title={`Only ${name}`}>
        <input
          type="checkbox"
          role="switch"
          className="mk-sw sm"
          aria-label={`${plugin.title} on for ${name}`}
          checked={on}
          disabled={busy}
          onChange={(e) => void change(e.target.checked, "project")}
        />
        <span className="sub">This project: {on ? "On" : "Off"}</span>
      </label>
      {every ? (
        <span className="sub">every project</span>
      ) : (
        <button
          type="button"
          className="linkbtn sub"
          disabled={busy}
          onClick={() => void change(true, "all")}
          aria-label={`Turn ${plugin.title} on for every project`}
        >
          For every project
        </button>
      )}
      {err && <span className="badc sub">{err.message}</span>}
    </div>
  );
}

/** What a per-project plugin adds where people already work (what Tools › Plugins' card said). */
export function PluginAdds({ plugin }: { plugin: Plugin }) {
  return (
    <dl className="mk-kv" aria-label="Where it adds things">
      {!!plugin.tools?.read?.length && (
        <>
          <dt>KeelBot tools</dt>
          <dd className="mono">{plugin.tools.read.join(", ")}</dd>
        </>
      )}
      {!!plugin.actions?.length && (
        <>
          <dt>Workflow blocks</dt>
          <dd className="mono">
            {plugin.actions.map((a) => a.name).join(", ")}
          </dd>
        </>
      )}
      {!!plugin.commands?.length && (
        <>
          <dt>Commands</dt>
          <dd className="mono">
            {plugin.commands.map((c) => `/${c.name}`).join(" ")}
          </dd>
        </>
      )}
      {!!plugin.shows_in?.length && (
        <>
          <dt>Shows in</dt>
          <dd>{plugin.shows_in.map((w) => WHERE[w] ?? w).join(" · ")}</dd>
        </>
      )}
    </dl>
  );
}

type Row = { id: string; name: string; plugin: Plugin | undefined };

/** The plugin's page: every project with its own switch. Nothing shows for a plugin no project switches. */
export function PluginProjects({ name }: { name: string }) {
  const { projects, projectsLoaded } = useApp();
  const ids = projects.map((p) => p.id).join(",");
  const rows = useLoad<Row[]>(
    projectsLoaded ? `plugin-projects:${name}:${ids}` : null,
    () =>
      Promise.all(
        projects.map(async (p) => ({
          id: p.id,
          name: p.name,
          plugin: (await api.plugins(p.id)).find((x) => x.name === name),
        })),
      ),
    { live: false },
  );
  const { busy, err, set } = useSwitch();
  if (rows.data && !rows.data.some((r) => r.plugin)) return null;
  const first = rows.data?.find((r) => r.plugin);
  const title = first?.plugin?.title ?? name;
  const allOn =
    !!rows.data?.length &&
    rows.data.every((r) => r.plugin?.enabled && r.plugin.scope === "all");
  const change = async (
    pid: string,
    enabled: boolean,
    scope: "project" | "all",
  ) => {
    if (await set(pid, { name, title }, enabled, scope)) await rows.reload();
  };
  return (
    <section className="panel" aria-labelledby="mk-projects">
      <div className="panel-head">
        <h2 id="mk-projects">Projects</h2>
        {first && !allOn && (
          <button
            type="button"
            className="btn sm"
            disabled={busy}
            onClick={() => void change(first.id, true, "all")}
          >
            On for every project
          </button>
        )}
      </div>
      <div className="panel-body">
        <p className="sub" style={{ margin: "0 0 10px" }}>
          Each project turns {title} on for itself. A project's own choice wins
          over "every project".
        </p>
        {rows.error ? (
          <ErrorBox error={rows.error} onRetry={() => void rows.reload()} />
        ) : !rows.data ? (
          <Loading what="Reading the projects" />
        ) : !rows.data.length ? (
          <p className="sub" style={{ margin: 0 }}>
            No project yet.
          </p>
        ) : (
          <ul className="mk-projlist" aria-label={`Projects with ${title}`}>
            {rows.data.map((r) => (
              <li key={r.id}>
                <input
                  type="checkbox"
                  role="switch"
                  className="mk-sw"
                  aria-label={`${title} on for ${r.name}`}
                  checked={!!r.plugin?.enabled}
                  disabled={busy || !r.plugin}
                  onChange={(e) =>
                    void change(r.id, e.target.checked, "project")
                  }
                />
                <b>{r.name}</b>
                <span className="sub">
                  {!r.plugin
                    ? "not offered here"
                    : r.plugin.scope === "all"
                      ? `${r.plugin.enabled ? "on" : "off"}: follows every project`
                      : r.plugin.scope === "project"
                        ? `${r.plugin.enabled ? "on" : "off"}: its own choice`
                        : "off"}
                </span>
              </li>
            ))}
          </ul>
        )}
        {err && <ErrorBox error={err} />}
      </div>
    </section>
  );
}
