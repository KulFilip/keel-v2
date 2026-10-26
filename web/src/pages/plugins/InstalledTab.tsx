import { useState } from "react";
import { Seg } from "../../components/settingsUi";
import { ErrorBox, Loading, Panel, Pill } from "../../components/ui";
import { FROM, pendingOf, revokedText, updateOf, type LiveNote, type PluginsView } from "../../marketplaceApi";
import { useApp, type Loaded } from "../../state";
import { LOADED_TIP, RemoveConfirm, StatusOf, canRemove, problemsOf, titleOf, usePluginAct } from "../PluginDetail";
import { ProjectPlace, useProjectPlugins } from "../PluginProjects";
import { KeelMark, PluginIcon, nested, useInside } from "../pluginLook";
import { AppliedNote, RowRestart } from "./Restart";

// ---------- Installed ----------

const CORE_PARTS = ["engine", "api", "web", "content"];

/** The keel-wide switch, with "On" or "Off" beside it (a plugin no project turns on for itself, and keel core). */
function OnSwitch({
  label,
  on,
  disabled,
  onChange,
}: {
  label: string;
  on: boolean;
  disabled?: boolean;
  onChange?: (on: boolean) => void;
}) {
  return (
    <label className="mk-onsw">
      <input
        type="checkbox"
        role="switch"
        className="mk-sw"
        aria-label={label}
        checked={on}
        disabled={disabled}
        readOnly={!onChange}
        onChange={(e) => onChange?.(e.target.checked)}
      />
      <span className="sub" aria-hidden="true">
        {on ? "On" : "Off"}
      </span>
    </label>
  );
}

export function InstalledTab({ view }: { view: Loaded<PluginsView> }) {
  const { health, pid } = useApp();
  // v0.17.1 the plugins a project turns on (db, git, ci, review): their "This project" switch (Tools › Plugins is gone)
  const perProject = useProjectPlugins(pid);
  const { busy, err, actions, notes } = usePluginAct(view.reload);
  const [removing, setRemoving] = useState<string | null>(null);
  // v0.17.1 the per-project control's own notes ("applied" for a plugin keel has loaded)
  const [placeNotes, setPlaceNotes] = useState<Record<string, LiveNote>>({});
  const inside = useInside(view.data?.plugins ?? []);
  const [filter, setFilter] = useState("");
  const [show, setShow] = useState<"all" | "on" | "off" | "updates">("all");
  if (view.error && !view.data)
    return <ErrorBox error={view.error} onRetry={() => void view.reload()} />;
  if (!view.data) return <Loading what="Reading the installed plugins" />;
  const v = view.data;
  const titles = new Map(v.plugins.map((p) => [p.name, titleOf(p)]));
  const all = nested(v.plugins, inside);
  // keel 0.18.57 Settings › Plugins: a filter by name and by state (All · On · Off · Updates)
  const q = filter.trim().toLowerCase();
  const fits = (p: (typeof v.plugins)[number]) =>
    (!q || `${titleOf(p)} ${p.name}`.toLowerCase().includes(q)) &&
    (show === "all" || (show === "on" && p.on !== false) || (show === "off" && p.on === false) || (show === "updates" && !!updateOf(p)));
  const rows = all.filter(({ p }) => fits(p));
  const coreShown = (!q || "keel core".includes(q)) && (show === "all" || show === "on");
  // the plugins whose change waits for the restart (the engine compares the next start with what is loaded)
  const pend = pendingOf(v);
  const waiting = new Set(
    pend?.pending ? (pend.changes ?? []).map((c) => c.name) : [],
  );
  return (
    <div className="grid">
      {v.engine === false && (
        <p className="sub">
          The engine does not answer: this is what keel loaded when it started.
        </p>
      )}
      {err && <ErrorBox error={err} />}
      <div className="ss-inline">
        <input type="search" className="ss-input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter installed plugins"
          aria-label="Filter installed plugins" style={{ flex: "1 1 220px", maxWidth: 320 }} />
        <Seg label="Show" value={show} onChange={setShow} options={[["all", "All"], ["on", "On"], ["off", "Off"], ["updates", "Updates"]]} />
      </div>
      <Panel body={false}>
        <div className="table-wrap rt-wrap">
          <table className="mk-table mk-installed rt">
            <thead>
              <tr>
                <th>Plugin</th>
                <th>Version</th>
                <th>Parts</th>
                <th>From</th>
                <th title="Whether keel loaded the plugin (for all of keel)">Status</th>
                <th title="Off, this project or all projects; keel core is always on">Where it is on</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {coreShown && <tr data-testid="keel-core">
                <td className="rt-main">
                  <div className="mk-pname">
                    <KeelMark />
                    <div>
                      <b>keel core</b>
                      <span className="sub">flows, agents, Inbox, settings</span>
                    </div>
                  </div>
                </td>
                <td className="mono" data-label="Version">
                  {health?.version?.replace(/^v/, "") ?? "—"}
                </td>
                <td>
                  <div className="mk-parts">
                    {CORE_PARTS.map((x) => (
                      <span key={x} className="tag">
                        {x}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="sub" data-label="From">the image</td>
                <td>
                  <Pill tone="ok" title={LOADED_TIP}>Loaded</Pill>
                </td>
                <td className="mk-oncell">
                  <Pill tone="ok">always on</Pill>
                </td>
                <td className="sub mk-right rt-end">Update the image</td>
              </tr>}
              {rows.map(({ p, parent, kids }) => {
                const upd = updateOf(p);
                const revoked = revokedText(p.revoked);
                const from = p.from ?? p.source ?? "";
                const problems = problemsOf(p);
                const a = actions(p);
                const off = p.on === false && p.status !== "restart";
                // a plugin each project turns on (the project's list has it): Off | This project | All projects
                const pp = perProject.data?.find((x) => x.name === p.name);
                return [
                  <tr
                    key={p.name}
                    className={[parent ? "child" : "", off ? "off" : ""]
                      .filter(Boolean)
                      .join(" ")}
                    data-testid={`plugin-${p.name}`}
                  >
                    <td className="rt-main">
                      <div className="mk-pname">
                        <PluginIcon name={p.name} title={p.title} size="sm" />
                        <div>
                          <a className="mk-plink" href={`#/settings/plugins/${encodeURIComponent(p.name)}`}>
                            {titleOf(p)}
                          </a>
                          <span className="sub">
                            {parent
                              ? `in ${titles.get(parent) ?? parent}`
                              : kids
                                ? `${kids} plugin${kids === 1 ? "" : "s"} inside`
                                : p.publisher || p.name}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className="mono" data-label="Version">
                      {p.version}
                      {upd && (
                        <div>
                          <span className="tag keel">{upd} ready</span>
                        </div>
                      )}
                    </td>
                    <td>
                      <div className="mk-parts">
                        {(p.parts ?? []).map((x) => (
                          <span key={x} className="tag">
                            {x}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="sub" data-label="From">{FROM[from] ?? from}</td>
                    <td>
                      {revoked ? (
                        <Pill tone="bad">revoked</Pill>
                      ) : (
                        <StatusOf p={p} problems={problems.length > 0} />
                      )}
                      {revoked && (
                        <div className="mk-warn">
                          This version was revoked: {revoked}
                        </div>
                      )}
                      {problems.map((x, i) => (
                        <div key={i} className="sub">
                          {x}
                        </div>
                      ))}
                      {!!p.needed_by?.length && (
                        <div className="sub">
                          {p.needed_by.join(", ")} need
                          {p.needed_by.length === 1 ? "s" : ""} it
                        </div>
                      )}
                    </td>
                    <td className="mk-oncell">
                      {pp && pid ? (
                        <ProjectPlace
                          pid={pid}
                          plugin={pp}
                          loaded={perProject}
                          keelOn={p.on !== false}
                          onKeelOn={() => void view.reload()}
                          loadedNow={
                            p.on !== false &&
                            p.status === "loaded" &&
                            !waiting.has(p.name)
                          }
                          onApplied={(now) =>
                            setPlaceNotes(({ [p.name]: _gone, ...rest }) =>
                              now ? { ...rest, [p.name]: "applied" } : rest,
                            )
                          }
                        />
                      ) : (
                        <OnSwitch
                          label={`${titleOf(p)} on`}
                          on={p.on !== false}
                          disabled={busy === p.name || p.status === "removed"}
                          onChange={(on) => void a.setOn(on)}
                        />
                      )}
                    </td>
                    <td className="rt-end">
                      <div className="mk-rowact">
                        {upd && (
                          <button
                            className="btn sm"
                            type="button"
                            disabled={busy === p.name}
                            onClick={() =>
                              void a.update(
                                typeof p.update === "string"
                                  ? p.update
                                  : undefined,
                              )
                            }
                          >
                            Update
                          </button>
                        )}
                        {p.previous && (
                          <button
                            className="btn sm ghost"
                            type="button"
                            disabled={busy === p.name}
                            onClick={() => void a.rollback()}
                          >
                            Roll back
                          </button>
                        )}
                        {canRemove(p) && p.status !== "removed" && (
                          <button
                            className="btn sm ghost mk-danger"
                            type="button"
                            disabled={busy === p.name}
                            onClick={() => setRemoving(p.name)}
                          >
                            Remove
                          </button>
                        )}
                      </div>
                      {waiting.has(p.name) ? (
                        <RowRestart
                          title={titleOf(p)}
                          view={v}
                          onDone={() => void view.reload()}
                        />
                      ) : (
                        <AppliedNote
                          note={notes[p.name] ?? placeNotes[p.name]}
                        />
                      )}
                    </td>
                  </tr>,
                  removing === p.name && (
                    <tr key={`${p.name}-remove`} className="mk-confirm-row">
                      <td colSpan={7}>
                        <RemoveConfirm
                          p={p}
                          busy={busy === p.name}
                          onNo={() => setRemoving(null)}
                          onYes={(data) =>
                            void a.remove(data).then(() => setRemoving(null))
                          }
                        />
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
      </Panel>
      {!v.plugins.length && (
        <p className="sub" style={{ margin: 0 }}>
          No plugins yet. Find one in the Marketplace tab.
        </p>
      )}
      {v.plugins.length > 0 && !rows.length && (q || show !== "all") && (
        <p className="sub" style={{ margin: 0 }}>
          No installed plugin matches. Try the marketplace.
        </p>
      )}
      {v.problems.length > 0 && (
        <Panel title="Left out at start">
          <ul className="mk-problems">
            {v.problems.map((x, i) => (
              <li key={i}>
                <b>{x.name}</b>
                {x.version ? (
                  <span className="mono sub"> {x.version}</span>
                ) : null}
                : {x.error}
              </li>
            ))}
          </ul>
        </Panel>
      )}
      <p className="sub" style={{ margin: 0 }}>
        Data stays when you turn a plugin off. A plugin that came in keel's
        image can be turned off, not removed.
      </p>
    </div>
  );
}
