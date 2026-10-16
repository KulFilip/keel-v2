// Control › Plugins (v0.16.0, docs/plugins/13-step4-contract.md §9; v0.16.1 the look of docs/plugins/mockup.html):
// what this keel has installed, the marketplace, and where plugins come from. Three tabs, and a page per plugin:
//
//   Installed           keel core first, then each plugin with its icon; the plugins that live inside another one's page
//                       (Git, Code Review, CI/CD and Database in Code) under it; version (and the update that is
//                       ready), parts, from, a status pill, on/off, Update, Roll back, Remove; "Check for updates"
//                       reads the catalogs again; a banner when changes wait for a restart. v0.17.1: a plugin each
//                       project turns on (db, git, ci, review) has one control [ Off | This project | All projects ]
//                       in place of the switch, with "on in 2 other projects" under it (PluginProjects.tsx); any
//                       other plugin a switch with "On"/"Off" beside it
//   Marketplace         the catalog, search, the category chips, the trust legend; "The keel set" and the community's
//                       plugins as cards (Install / Update to x / Installed). No catalog yet: keel's own plugins from
//                       the image, with a note, never an empty page
//   Sources and rules   the catalogs (add one with its URL and public key, refresh, problems), the four rules, and
//                       install from a file in /data
//   #/plugins/<name>    the plugin's own page (PluginDetail.tsx): about, permissions, versions, checks, needs, and
//                       (v0.17.1) the projects it is on for
//
// Install opens a dialog that lists everything that will be installed and what each one may do.
// #/plugins?set=developer (the core-only welcome's set cards) opens the install question for what that set adds at
// once (the missing plugins; the image's plugins that are off are turned on); nothing installs before the person presses
// Install. #/plugins?tab=market|installed|sources opens that tab.

import { useEffect, useMemo, useRef, useState } from "react";
import { errorParts } from "../api";
import {
  Confirm,
  Drawer,
  ErrorBox,
  Loading,
  PageHead,
  Panel,
  Pill,
  Tabs,
} from "../components/ui";
import { PermissionList, TrustTag } from "../components/Permissions";
import { clock } from "../format";
import {
  FROM,
  TRUST,
  hitsOf,
  installedVersion,
  marketApi,
  needsOf,
  newestVersion,
  pendingOf,
  permissionsOf,
  planOf,
  publisherOf,
  turnOnOf,
  revokedText,
  setsOf,
  sourceStatusOf,
  sourcesOf,
  updateOf,
  type InstalledPlugin,
  type MarketHit,
  type MarketPlugin,
  type Permissions,
  type PluginsView,
  type Rules,
  type Source,
} from "../marketplaceApi";
import { queryValue } from "../routes";
import type { PageProps } from "../sdk/registry";
import { useApp, useLoad, useRoute, type Loaded } from "../state";
import {
  PluginDetailPage,
  RemoveConfirm,
  StatusOf,
  canRemove,
  problemsOf,
  titleOf,
  usePluginAct,
  type Err,
} from "./PluginDetail";
import { ProjectPlace, useProjectPlugins } from "./PluginProjects";
import {
  CHIPS,
  KeelMark,
  PluginIcon,
  Publisher,
  fromKeel,
  inChip,
  isBeta,
  nested,
  useInside,
  type Chip,
} from "./pluginLook";

type Tab = "installed" | "market" | "sources";

/** What the install dialog does: install these (and what they need), then turn these on. */
type InstallPlan = { install: string[]; turnOn?: string[]; title?: string };

const SUB: Record<Tab, string> = {
  installed:
    "What this keel has installed. Turn a plugin off to hide it without losing its data. Plugins that came in the image can be updated from the marketplace.",
  market:
    "Plugins add pages, tools, workflows and agents to keel. Each comes from its own git repo. keel checks its signature before it installs it.",
  sources: "Where plugins come from, and who may install them.",
};

export function PluginsPage(_props: PageProps) {
  const route = useRoute();
  // #/plugins/<name>: the router hands a keel-wide page no arg, so the page reads its own link
  const arg = route.arg;
  const { toast } = useApp();
  const setId = queryValue(route, "set");
  const view = useLoad("plugins", () => marketApi.installed());
  // #/plugins?tab=market (the core welcome's "Open the marketplace", the menu's "+ Add pages"), tab=installed|sources
  const asked = queryValue(route, "tab");
  const linked: Tab | null =
    asked === "market" || asked === "installed" || asked === "sources"
      ? asked
      : null;
  const [tab, setTab] = useState<Tab>(linked ?? "installed");
  useEffect(() => {
    if (linked) setTab(linked);
  }, [linked, route.query]);
  const [plan, setPlan] = useState<InstallPlan | null>(null);
  // the list was shown before a plugin's page: its crumb goes back to the tab the person came from
  const [listed, setListed] = useState(!arg);
  useEffect(() => {
    if (!arg) setListed(true);
  }, [arg]);
  const [checking, setChecking] = useState(false);
  const [err, setErr] = useState<Err>(null);
  const count = view.data?.plugins.length;
  const waiting = view.data ? (pendingOf(view.data)?.changes ?? []).length : 0;

  const back = (t: Tab) => {
    setTab(t);
    if (location.hash !== "#/plugins") location.hash = "#/plugins";
  };
  // "Check for updates": read the catalogs again, then show what has an update
  const check = async () => {
    setChecking(true);
    setErr(null);
    try {
      await marketApi.refresh();
      const fresh = await marketApi.installed();
      view.setData(fresh);
      const ready = fresh.plugins.filter((p) => updateOf(p));
      setTab("installed");
      toast(
        ready.length
          ? `${ready.length} update${ready.length === 1 ? "" : "s"} ready: ${ready.map(titleOf).join(", ")}.`
          : "Every plugin is up to date.",
      );
    } catch (e) {
      setErr(errorParts(e));
    } finally {
      setChecking(false);
    }
  };

  const dialog = plan && (
    <InstallDialog
      plan={plan}
      view={view.data}
      onClose={() => setPlan(null)}
      onDone={() => {
        void view.reload();
        if (setId) location.hash = "#/plugins";
      }}
    />
  );

  if (arg)
    return (
      <>
        {view.data && (
          <RestartBanner view={view.data} onDone={() => void view.reload()} />
        )}
        <PluginDetailPage
          key={arg}
          name={arg}
          view={view}
          back={
            listed
              ? tab
              : view.data?.plugins.some((p) => p.name === arg)
                ? "installed"
                : "market"
          }
          onBack={back}
          onInstall={(name) => setPlan({ install: [name] })}
        />
        {dialog}
      </>
    );

  return (
    <>
      <PageHead
        title="Plugins"
        sub={SUB[tab]}
        actions={
          tab === "installed" ? (
            <>
              <button
                className="btn"
                type="button"
                disabled={checking}
                onClick={() => void check()}
              >
                {checking ? "Checking…" : "Check for updates"}
              </button>
              <button
                className="btn primary"
                type="button"
                onClick={() => setTab("market")}
              >
                Browse marketplace
              </button>
            </>
          ) : tab === "market" ? (
            <CatalogLine onSources={() => setTab("sources")} />
          ) : undefined
        }
      />
      {err && <ErrorBox error={err} />}
      {view.data && (
        <RestartBanner view={view.data} onDone={() => void view.reload()} />
      )}
      {setId && (
        <SetOffer
          id={setId}
          view={view.data}
          onInstall={(p) => setPlan(p)}
          onClose={() => {
            location.hash = "#/plugins";
          }}
        />
      )}
      <div className="mk-tabsrow">
        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          label="Plugins"
          options={[
            [
              "installed",
              count === undefined ? "Installed" : `Installed (${count})`,
            ],
            ["market", "Marketplace"],
            ["sources", "Sources and rules"],
          ]}
        />
        {waiting > 0 && (
          <Pill tone="warn">{waiting} waiting for restart</Pill>
        )}
      </div>
      <div className="mk-tab">
        {tab === "installed" && <InstalledTab view={view} />}
        {tab === "market" && (
          <MarketTab
            view={view.data}
            onInstall={(name) => setPlan({ install: [name] })}
            onChanged={() => void view.reload()}
          />
        )}
        {tab === "sources" && (
          <SourcesTab onChanged={() => void view.reload()} />
        )}
      </div>
      {dialog}
    </>
  );
}

/** "Catalog keel official · Sources": the catalogs keel reads, and a way to them. */
function CatalogLine({ onSources }: { onSources: () => void }) {
  const src = useLoad("plugin-sources", () => marketApi.sources(), {
    live: false,
  });
  const on = sourcesOf(src.data).filter((s) => s.on !== false);
  return (
    <div className="mk-catalog">
      <span className="sub">Catalog</span>
      {on.map((s) => (
        <span
          key={s.id}
          className={`tag ${s.ok === false || s.problem ? "warn" : "keel"}`}
          title={s.problem ?? undefined}
        >
          {s.title || s.id}
        </span>
      ))}
      {src.data && !on.length && <span className="tag warn">none</span>}
      <button className="btn sm ghost" type="button" onClick={onSources}>
        Sources
      </button>
    </div>
  );
}

// ---------- the restart banner ----------

function RestartBanner({
  view,
  onDone,
}: {
  view: PluginsView;
  onDone: () => void;
}) {
  const { toast } = useApp();
  const r = view.restart;
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState(false);
  const [gone, setGone] = useState(false);
  const [err, setErr] = useState<Err>(null);
  if (!r || (!r.pending && !r.scheduled)) return null;
  // keel-start does not run this keel (a dev run): it cannot restart itself
  const manual = r.supervised === false;
  // what loads after the restart: db 1.3.0 → 1.4.0, hello new, map gone
  const changes = (pendingOf(view)?.changes ?? []).map((c) =>
    c.now && c.next
      ? `${c.name} ${c.now} → ${c.next}`
      : c.next
        ? `${c.name} ${c.next} (new)`
        : `${c.name} (goes)`,
  );
  const restart = async (now: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      const a = await marketApi.restart(now);
      if (a.restarting) {
        setGone(true);
        toast("keel restarts now. This page comes back in about 30 seconds.");
      } else toast("keel restarts by itself when no agent step runs.");
      onDone();
    } catch (e) {
      setErr(errorParts(e));
    } finally {
      setBusy(false);
      setAsk(false);
    }
  };
  return (
    <div className="mk-banner" role="status">
      <div className="mk-banner-t">
        <b>{gone ? "keel is restarting…" : "Changes wait for a restart"}</b>
        <span className="sub">
          {gone
            ? "It loads the plugins again. This page comes back in about 30 seconds."
            : manual
              ? "keel loads new and changed plugins when it starts again. keel-start does not run this keel: restart it by hand with keel2 restart."
              : r.scheduled
                ? `keel restarts by itself when no agent step runs${r.running ? ` (${r.running} running now)` : ""}.`
                : "keel loads new and changed plugins when it starts again. It takes about 30 seconds."}
        </span>
        {!gone && changes.length > 0 && (
          <span className="sub mono" aria-label="What changes">
            {changes.join(" · ")}
          </span>
        )}
      </div>
      {!gone &&
        !manual &&
        (ask ? (
          <Confirm
            text={`${r.running} agent step${r.running === 1 ? "" : "s"} run now. They stop, and go on after the restart.`}
            yes="Restart anyway"
            busy={busy}
            onYes={() => void restart(true)}
            onNo={() => setAsk(false)}
          />
        ) : (
          <div className="row">
            <button
              className="btn warn"
              type="button"
              disabled={busy}
              onClick={() =>
                r.running > 0 ? setAsk(true) : void restart(true)
              }
            >
              Restart keel
            </button>
            {!r.scheduled && (
              <button
                className="btn"
                type="button"
                disabled={busy}
                onClick={() => void restart(false)}
              >
                Restart when no agent runs
              </button>
            )}
          </div>
        ))}
      {err && <ErrorBox error={err} />}
    </div>
  );
}

// ---------- Start with a set ----------

function SetOffer({
  id,
  view,
  onInstall,
  onClose,
}: {
  id: string;
  view: PluginsView | null;
  onInstall: (p: InstallPlan) => void;
  onClose: () => void;
}) {
  const sets = useLoad("plugin-sets", () => marketApi.sets(), { live: false });
  const set = setsOf(sets.data).find((s) => s.id === id);
  const have = new Map((view?.plugins ?? []).map((p) => [p.name, p]));
  const missing = set ? set.plugins.filter((n) => !have.has(n)) : [];
  const off = set ? set.plugins.filter((n) => have.get(n)?.on === false) : [];
  const title = set?.title ?? id;
  const plan: InstallPlan = {
    install: missing,
    turnOn: off,
    title: `Install the ${title} set?`,
  };
  // a set's link (the core welcome's set card) opens its install question at once, one time; nothing installs
  // until the person presses Install there
  const opened = useRef("");
  const ready = !!set && !!view && missing.length + off.length > 0;
  useEffect(() => {
    if (!ready || opened.current === id) return;
    opened.current = id;
    onInstall(plan);
    // the plan is read when the set and the installed plugins are there
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, id]);
  return (
    <Panel
      className="mk-set"
      title={<h2>Start with the {title} set</h2>}
      extra={
        <button className="btn sm ghost" type="button" onClick={onClose}>
          Not now
        </button>
      }
    >
      {sets.error && !sets.data ? (
        <ErrorBox error={sets.error} onRetry={() => void sets.reload()} />
      ) : !sets.data || !view ? (
        <Loading what="Reading the set" />
      ) : !set ? (
        <p className="sub">There is no set called {id}.</p>
      ) : (
        <div className="grid mk-set-body">
          {set.summary && (
            <p className="sub" style={{ margin: 0 }}>
              {set.summary}
            </p>
          )}
          <ul className="mk-set-list" aria-label={`The ${title} set`}>
            {set.plugins.map((n) => {
              const p = have.get(n);
              return (
                <li key={n}>
                  <b>{p?.title ?? n}</b>{" "}
                  {!p ? (
                    <Pill tone="warn">will be installed</Pill>
                  ) : p.on === false ? (
                    <Pill tone="idle">off: turns on</Pill>
                  ) : (
                    <Pill tone="ok">here</Pill>
                  )}
                </li>
              );
            })}
          </ul>
          {missing.length + off.length === 0 ? (
            <p className="sub" style={{ margin: 0 }}>
              Everything in this set is here already.
            </p>
          ) : (
            <div className="row">
              <button
                className="btn primary"
                type="button"
                onClick={() =>
                  onInstall(plan)
                }
              >
                {missing.length ? `Install ${missing.length}` : ""}
                {missing.length && off.length ? " and " : ""}
                {off.length ? `turn on ${off.length}` : ""}
              </button>
              <span className="sub">Then keel restarts once.</span>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

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

function InstalledTab({ view }: { view: Loaded<PluginsView> }) {
  const { health, pid } = useApp();
  // v0.17.1 the plugins a project turns on (db, git, ci, review): their "This project" switch (Tools › Plugins is gone)
  const perProject = useProjectPlugins(pid);
  const { busy, err, actions } = usePluginAct(view.reload);
  const [removing, setRemoving] = useState<string | null>(null);
  const inside = useInside(view.data?.plugins ?? []);
  if (view.error && !view.data)
    return <ErrorBox error={view.error} onRetry={() => void view.reload()} />;
  if (!view.data) return <Loading what="Reading the installed plugins" />;
  const v = view.data;
  const titles = new Map(v.plugins.map((p) => [p.name, titleOf(p)]));
  const rows = nested(v.plugins, inside);
  return (
    <div className="grid">
      {v.engine === false && (
        <p className="sub">
          The engine does not answer: this is what keel loaded when it started.
        </p>
      )}
      {err && <ErrorBox error={err} />}
      <Panel body={false}>
        <div className="table-wrap rt-wrap">
          <table className="mk-table mk-installed rt">
            <thead>
              <tr>
                <th>Plugin</th>
                <th>Version</th>
                <th>Parts</th>
                <th>From</th>
                <th>Status</th>
                <th>On</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr data-testid="keel-core">
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
                  <Pill tone="ok">On</Pill>
                </td>
                <td className="mk-oncell">
                  <OnSwitch label="keel core on" on disabled />
                </td>
                <td className="sub mk-right rt-end">Update the image</td>
              </tr>
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
                          <a className="mk-plink" href={`#/plugins/${p.name}`}>
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

// ---------- Marketplace ----------

function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** An installed plugin as a card, when no catalog answers: what keel's image (or its copy) knows. */
const localHit = (p: InstalledPlugin): MarketHit => ({
  name: p.name,
  title: p.title,
  publisher: p.publisher || undefined,
  verified: (p.publisher ?? "") === "keel",
  summary: p.summary ?? undefined,
  trust: p.trust ?? undefined,
  version: p.version,
  installed: p.version ?? true,
  installed_from: (p.from as MarketHit["installed_from"]) ?? null,
  update: p.update ?? null,
  needs: p.needs,
});

function MarketTab({
  view,
  onInstall,
  onChanged,
}: {
  view: PluginsView | null;
  onInstall: (name: string) => void;
  onChanged: () => void;
}) {
  const { toast } = useApp();
  const [typed, setTyped] = useState("");
  const q = useDebounced(typed.trim());
  const [chip, setChip] = useState<Chip>("all");
  const r = useLoad(`market:${q}`, () => marketApi.search(q));
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<Err>(null);
  const statuses = sourceStatusOf(r.data);
  const have = useMemo(
    () => new Map((view?.plugins ?? []).map((p) => [p.name, p])),
    [view],
  );
  // no catalog answers (the official one is not set up yet): keel's own plugins from the image, never an empty page
  const down =
    !!r.error ||
    (statuses.length > 0 && statuses.every((s) => s.ok === false));
  const catalogHits = hitsOf(r.data);
  const local =
    !!view && (!!r.data || !!r.error) && !catalogHits.length && (down || !q);
  const words = typed.trim().toLowerCase();
  const all = local
    ? (view?.plugins ?? [])
        .filter((p) => p.status !== "removed")
        .map(localHit)
        .filter(
          (h) =>
            !words ||
            [h.name, h.title, h.summary]
              .join(" ")
              .toLowerCase()
              .includes(words),
        )
    : catalogHits;
  const hits = all.filter((h) => inChip(h, chip));
  const titles = new Map<string, string>([
    ...(view?.plugins ?? []).map((p): [string, string] => [p.name, titleOf(p)]),
    ...catalogHits.map((h): [string, string] => [h.name, h.title ?? h.name]),
  ]);
  const update = async (h: MarketHit, to: string) => {
    setBusy(h.name);
    setErr(null);
    try {
      await marketApi.update(h.name, to || undefined);
      toast(`${h.title ?? h.name} is updated. Restart keel to use it.`);
      onChanged();
      await r.reload();
    } catch (e) {
      setErr(errorParts(e));
    } finally {
      setBusy(null);
    }
  };
  const card = (h: MarketHit) => {
    const pub = publisherOf(h);
    const mine = have.get(h.name);
    const inst = installedVersion(h) ?? mine?.version ?? (mine ? "" : null);
    const upd = updateOf(h);
    const needs = needsOf(h);
    const revoked = revokedText(h.revoked);
    const title = h.title ?? h.name;
    const version = h.version ?? h.latest;
    return (
      <article key={h.name} className="mk-card" aria-label={`${title} plugin`}>
        <div className="mk-card-h">
          <PluginIcon
            name={h.name}
            title={title}
            icon={(h as { icon?: unknown }).icon}
          />
          <div style={{ minWidth: 0 }}>
            <h3>
              <a className="mk-card-link" href={`#/plugins/${h.name}`}>
                {title}
              </a>
              {isBeta(version) && <span className="tag warn">beta</span>}
            </h3>
            <div className="mk-by">
              <Publisher name={pub.name} verified={pub.verified} />
              {version && <span className="mono faint">{version}</span>}
            </div>
          </div>
        </div>
        <p className="mk-sum">{h.summary}</p>
        {h.fits === false && h.why_not && (
          <p className="sub mk-sum">{h.why_not}</p>
        )}
        <div className="mk-card-f">
          <span className="mk-card-tags">
            <TrustTag trust={h.trust} />
            {needs.length > 0 && (
              <span className="tag">
                needs {needs.map((n) => titles.get(n) ?? n).join(", ")}
              </span>
            )}
            {h.fits === false && (
              <Pill tone="warn" title={h.why_not ?? undefined}>
                does not fit this keel
              </Pill>
            )}
            {revoked && <Pill tone="bad">revoked</Pill>}
          </span>
          {inst !== null ? (
            upd ? (
              <button
                className="btn sm"
                type="button"
                disabled={busy === h.name}
                onClick={() =>
                  void update(h, typeof h.update === "string" ? h.update : "")
                }
              >
                Update to {upd}
              </button>
            ) : mine?.status === "restart" ? (
              <Pill tone="warn">Restart needed</Pill>
            ) : mine?.on === false ? (
              <Pill tone="idle">Installed · off</Pill>
            ) : (
              <Pill tone="ok">Installed</Pill>
            )
          ) : (
            <button
              className="btn sm primary"
              type="button"
              disabled={h.fits === false}
              onClick={() => onInstall(h.name)}
              aria-label={`Install ${title}`}
            >
              Install
            </button>
          )}
        </div>
      </article>
    );
  };
  const keel = hits.filter((h) => fromKeel(h));
  const community = hits.filter((h) => !fromKeel(h));
  return (
    <div className="grid mk-market">
      <div className="mk-searchrow">
        <label className="mk-search">
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              d="M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4"
            />
          </svg>
          <input
            type="search"
            placeholder="Search plugins: database, review, tickets…"
            aria-label="Search plugins: database, review, tickets…"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </label>
        <div className="mk-chips" role="group" aria-label="Category">
          {CHIPS.map(([id, label]) => (
            <button
              key={id}
              className="mk-chip"
              type="button"
              aria-pressed={chip === id}
              onClick={() => setChip(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="mk-legend">
        {Object.keys(TRUST).map((t) => (
          <TrustTag key={t} trust={t} />
        ))}
        <span className="faint">· what a plugin is allowed to bring</span>
      </div>
      {statuses
        // with no catalog at all, the note below says it once
        .filter((s) => !local && (s.old || s.problem || s.ok === false))
        .map((s) => (
          <p key={s.id} className="mk-note" role="note">
            <b>{s.id}</b>:{" "}
            {s.old
              ? "the catalog is old: search works, installs wait until a refresh works. "
              : ""}
            {s.problem ?? ""}
          </p>
        ))}
      {local && (
        <p className="mk-note mk-local" aria-label="No catalog yet">
          <b>
            {down
              ? "The catalog is not set up yet."
              : "The catalogs list no plugins yet."}
          </b>{" "}
          These are the plugins keel already has, from its image. Add a catalog
          in Sources and rules to find more.
          {statuses
            .filter((s) => s.problem)
            .map((s) => (
              <span key={s.id} className="sub" style={{ display: "block" }}>
                {s.id}: {s.problem}
              </span>
            ))}
        </p>
      )}
      {err && <ErrorBox error={err} />}
      {r.error && !r.data && !local ? (
        <ErrorBox error={r.error} onRetry={() => void r.reload()} />
      ) : !r.data && !local ? (
        <Loading what="Searching the catalogs" />
      ) : !hits.length ? (
        <div className="mk-empty">
          {typed.trim()
            ? `No plugin matches “${typed.trim()}”. Try another word, or ask an agent to look for one.`
            : chip !== "all"
              ? "No plugin in this category yet."
              : "The catalogs list no plugins yet."}
        </div>
      ) : (
        <>
          {keel.length > 0 && (
            <section aria-labelledby="mk-keelset">
              <div className="mk-sect">
                <h2 id="mk-keelset">The keel set</h2>
                <p className="sub">
                  Made and signed by keel. Each one was part of keel before.
                </p>
              </div>
              <div className="mk-cards">{keel.map(card)}</div>
            </section>
          )}
          {community.length > 0 && (
            <section aria-labelledby="mk-community">
              <div className="mk-sect">
                <h2 id="mk-community">From the community</h2>
                <p className="sub">
                  Published through a pull request to a catalog repo.
                </p>
              </div>
              <div className="mk-cards">{community.map(card)}</div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

// ---------- the install dialog ----------

type Item = {
  name: string;
  title: string;
  version?: string;
  trust?: string;
  permissions?: Permissions;
  publisher?: string;
  verified?: boolean;
  target: boolean;
  /** why it cannot be installed (not in the catalogs): it is left out */
  problem?: string;
};

function InstallDialog({
  plan,
  view,
  onClose,
  onDone,
}: {
  plan: InstallPlan;
  view: PluginsView | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useApp();
  const [items, setItems] = useState<Item[] | null>(null);
  // the targets no catalog has (or keel would refuse): never installed on their own
  const [unlisted, setUnlisted] = useState<Set<string>>(new Set());
  // what the installs turn on by themselves (needed plugins that are off)
  const [alsoOn, setAlsoOn] = useState<string[]>([]);
  const [loadErr, setLoadErr] = useState<Err>(null);
  const [state, setState] = useState<
    Record<string, "waiting" | "installing" | "done" | "failed">
  >({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Err>(null);
  const have = useMemo(
    () => new Set((view?.plugins ?? []).map((p) => p.name)),
    [view],
  );
  const turnOn = plan.turnOn ?? [];

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        // a set may name a plugin no catalog has: it shows with the reason and is left out
        const found = await Promise.all(
          plan.install.map((n) =>
            marketApi.plugin(n).then(
              (d) => ({ n, d }),
              (e: unknown) => ({ n, problem: errorParts(e).message }),
            ),
          ),
        );
        // one keel would refuse (revoked, the catalog is old, it does not fit) is left out too, with the reason
        const details = found.flatMap((f) =>
          "d" in f && !f.d.refused ? [f.d] : [],
        );
        const byName = new Map<string, MarketPlugin>(
          details.map((d) => [d.name, d]),
        );
        const left: Item[] = found.flatMap((f) =>
          "problem" in f
            ? [{ name: f.n, title: f.n, target: true, problem: f.problem }]
            : f.d.refused
              ? [
                  {
                    name: f.n,
                    title: f.d.title ?? f.n,
                    target: true,
                    problem: [f.d.refused.error, f.d.refused.hint]
                      .filter(Boolean)
                      .join(" "),
                  },
                ]
              : [],
        );
        const turning = details.flatMap(turnOnOf);
        const out: Item[] = [];
        for (const d of details) {
          for (const it of planOf(d)) {
            if (
              out.some((x) => x.name === it.name) ||
              (have.has(it.name) && !plan.install.includes(it.name))
            )
              continue;
            let own = byName.get(it.name);
            if (!own)
              own = await marketApi.plugin(it.name).catch(() => undefined);
            if (own) byName.set(it.name, own);
            const pub = it.publisher
              ? publisherOf(it)
              : own
                ? publisherOf(own)
                : null;
            out.push({
              name: it.name,
              title: it.title ?? own?.title ?? it.name,
              version: it.version ?? (own ? newestVersion(own) : undefined),
              trust:
                it.trust ??
                (typeof own?.trust === "string" ? own.trust : undefined),
              permissions:
                it.permissions ?? (own ? permissionsOf(own) : undefined),
              publisher: pub?.name,
              verified: pub?.verified,
              target: plan.install.includes(it.name),
            });
          }
        }
        // one another plugin's plan brings in is not left out, but it is never installed on its own
        if (live) {
          setAlsoOn(
            turning.filter(
              (n, i) => turning.indexOf(n) === i && !turnOn.includes(n),
            ),
          );
          setUnlisted(new Set(left.map((l) => l.name)));
          setItems([
            ...out,
            ...left.filter((l) => !out.some((o) => o.name === l.name)),
          ]);
        }
      } catch (e) {
        if (live) setLoadErr(errorParts(e));
      }
    })();
    return () => {
      live = false;
    };
    // the plan is fixed while the dialog is open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const main = items?.find((x) => x.target && !x.problem);
  const extra = items?.filter((x) => !x.target) ?? [];
  const nothing = !!items && !items.some((x) => !x.problem) && !turnOn.length;
  // one plugin (and what it needs): its name and version; several: how many
  const title =
    plan.title ??
    (plan.install.length > 1
      ? `Install ${plan.install.length} plugins?`
      : main
        ? `Install ${main.title}${main.version ? " " + main.version : ""}?`
        : `Install ${plan.install[0] ?? ""}?`);
  const runsCode = items?.some((x) => x.trust === "code");
  const unverified = items?.some(
    (x) => (x.trust === "code" || x.trust === "web") && x.verified === false,
  );

  const install = async () => {
    setBusy(true);
    setErr(null);
    let done = 0;
    try {
      for (const name of plan.install) {
        if (unlisted.has(name)) continue;
        // a set's earlier install may have brought this one in already
        const now = await marketApi.installed();
        if (now.plugins.some((p) => p.name === name)) continue;
        setState((s) => ({ ...s, [name]: "installing" }));
        const it = items?.find((x) => x.name === name);
        try {
          await marketApi.install(
            name,
            plan.install.length === 1 ? it?.version : undefined,
          );
        } catch (e) {
          setState((s) => ({ ...s, [name]: "failed" }));
          throw e;
        }
        setState((s) => ({ ...s, [name]: "done" }));
        done++;
      }
      for (const name of turnOn) await marketApi.setOn(name, true);
      const names = [
        ...(items ?? [])
          .filter((x) => x.target && !x.problem)
          .map((x) => x.title),
        ...turnOn,
      ];
      toast(
        names.length === 1 && done === 1
          ? `${names[0]} is installed. Restart keel to use it.`
          : "The plugins are ready. Restart keel to use them.",
      );
      onDone();
      onClose();
    } catch (e) {
      setErr(errorParts(e));
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      title={title}
      onClose={onClose}
      id="install-dialog"
      footer={
        <>
          <button
            className="btn"
            type="button"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            className="btn primary"
            type="button"
            onClick={() => void install()}
            disabled={busy || !items || nothing}
          >
            {busy ? "Installing…" : "Install"}
          </button>
        </>
      }
    >
      {loadErr ? (
        <ErrorBox error={loadErr} />
      ) : !items ? (
        <Loading what="Reading what will be installed" />
      ) : (
        <>
          {extra.length > 0 && plan.install.length === 1 && (
            <div className="mk-note" role="note">
              <b>Also installs {extra.map((x) => x.title).join(", ")}</b>{" "}
              <span className="sub">
                {main?.title ?? plan.install[0]} needs{" "}
                {extra.length === 1 ? "it" : "them"} to work.
              </span>
            </div>
          )}
          <p className="sub" style={{ margin: 0 }}>
            Everything that will be installed, and what each one may do:
          </p>
          <ul className="mk-install-list" aria-label="What will be installed">
            {items.map((x) => (
              <li key={x.name} className="mk-install-item">
                <div className="row">
                  <b>{x.title}</b>
                  {x.version && <span className="mono sub">{x.version}</span>}
                  <TrustTag trust={x.trust} />
                  {x.publisher && (
                    <span className="sub">
                      by {x.publisher}
                      {x.verified
                        ? " ✓"
                        : x.verified === false
                          ? " (not verified)"
                          : ""}
                    </span>
                  )}
                  {state[x.name] === "installing" && (
                    <Pill tone="run">installing</Pill>
                  )}
                  {state[x.name] === "done" && <Pill tone="ok">installed</Pill>}
                  {state[x.name] === "failed" && <Pill tone="bad">failed</Pill>}
                </div>
                {x.problem ? (
                  <span className="mk-warn">Left out: {x.problem}</span>
                ) : (
                  <PermissionList permissions={x.permissions} compact />
                )}
              </li>
            ))}
          </ul>
          {turnOn.length > 0 && (
            <p style={{ margin: 0 }}>
              Turns on (they came in keel's image): <b>{turnOn.join(", ")}</b>
            </p>
          )}
          {alsoOn.length > 0 && (
            <p style={{ margin: 0 }}>
              Also turns on what it needs: <b>{alsoOn.join(", ")}</b>
            </p>
          )}
          {runsCode && (
            <p className="mk-note">
              {unverified
                ? "A publisher here is not verified. Its code would run inside keel with keel's rights."
                : "Code from these plugins runs inside keel. keel checks that their publisher signed them."}
            </p>
          )}
          <p className="sub" style={{ margin: 0 }}>
            Nothing runs while it installs. keel loads the plugins when it
            restarts.
          </p>
          {err && <ErrorBox error={err} />}
        </>
      )}
    </Drawer>
  );
}

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

function SourcesTab({ onChanged }: { onChanged: () => void }) {
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
    done: string,
  ) => {
    setBusy(what);
    setErr(null);
    try {
      await fn();
      toast(done);
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
    const id = slug(title.trim() || host.split(".")[0] || "catalog");
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
        "The file is installed, as unsigned. Restart keel to use it.",
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
