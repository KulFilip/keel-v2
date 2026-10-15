// v0.16.1 one plugin's own page, #/plugins/<name> (docs/plugins/mockup.html "Plugin detail"): the big icon, title,
// publisher, version, trust and repo; the main button (Install / Update / Turn off / Remove); ABOUT with each part it
// brings; PERMISSIONS with their levels; VERSIONS from the catalog; the checks keel runs; what it needs. A plugin from
// keel's image that no catalog lists shows what keel knows about it. v0.17.1: a plugin each project turns on (db, git,
// ci, review) also says what it adds and lists the projects with their switch (PluginProjects.tsx).
//
// Also the pieces the Installed table shares with it: a plugin's status pill, the Remove question, and the actions.

import { useState, type ReactNode } from "react";
import { errorParts } from "../api";
import { PermissionList, TrustTag } from "../components/Permissions";
import { Confirm, ErrorBox, Loading, Pill } from "../components/ui";
import {
  installedVersion,
  marketApi,
  needsOf,
  newestVersion,
  permissionLines,
  permissionsOf,
  planOf,
  publisherOf,
  revokedText,
  TRUST,
  updateOf,
  type InstalledPlugin,
  type MarketPlugin,
  type PluginsView,
} from "../marketplaceApi";
import { useApp, useLoad, type Loaded } from "../state";
import {
  PART_WORDS,
  PluginIcon,
  Publisher,
  TRUST_PARTS,
  isBeta,
  piecesOf,
} from "./pluginLook";
import { PluginAdds, PluginProjects, useProjectPlugins } from "./PluginProjects";

export type Err = { message: string; hint?: string; details?: string[] } | null;

// ---------- shared with the Installed table ----------

/** A plugin's status in words: on (runs now), after restart (loads at the next start), off, left out, removed. */
export function StatusOf({
  p,
  problems,
}: {
  p: InstalledPlugin;
  problems: boolean;
}) {
  const s = p.status ?? "";
  if (s === "left out" || (problems && s !== "restart"))
    return <Pill tone="bad">left out</Pill>;
  if (s === "restart")
    return (
      <Pill tone="warn">
        {p.on === false ? "off after restart" : "after restart"}
      </Pill>
    );
  if (s === "removed") return <Pill tone="warn">removed at restart</Pill>;
  if (s === "off" || p.on === false) return <Pill tone="idle">Off</Pill>;
  return <Pill tone="ok">On</Pill>;
}

export const titleOf = (p: { name: string; title?: string | null }) =>
  p.title || p.name;

export const problemsOf = (p: InstalledPlugin) =>
  (p.problems ?? [])
    .map((x) => (typeof x === "string" ? x : (x.error ?? "")))
    .filter(Boolean);

export const canRemove = (p: InstalledPlugin) =>
  p.can_remove ?? (p.from ?? p.source ?? "") !== "image";

/** Run one change (update, roll back, on/off, remove), then say so and read the installed plugins again. */
export function usePluginAct(reload: () => Promise<void> | void) {
  const { toast } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<Err>(null);
  const act = async (
    name: string,
    run: () => Promise<unknown>,
    done: string,
  ): Promise<boolean> => {
    setBusy(name);
    setErr(null);
    try {
      await run();
      toast(done);
      await reload();
      return true;
    } catch (e) {
      setErr(errorParts(e));
      return false;
    } finally {
      setBusy(null);
    }
  };
  const actions = (p: InstalledPlugin) => {
    const t = titleOf(p);
    return {
      setOn: (on: boolean) =>
        act(
          p.name,
          () => marketApi.setOn(p.name, on),
          `${t} is ${on ? "on" : "off"} after the next restart.`,
        ),
      update: (to?: string) =>
        act(
          p.name,
          () => marketApi.update(p.name, to),
          `${t} is updated. Restart keel to use it.`,
        ),
      rollback: () =>
        act(
          p.name,
          () => marketApi.rollback(p.name),
          `${t} goes back to ${p.previous} after the restart.`,
        ),
      remove: (data: "keep" | "delete") =>
        act(
          p.name,
          () => marketApi.remove(p.name, data),
          `${t} is removed after the restart.`,
        ),
    };
  };
  return { busy, err, setErr, act, actions };
}

/** "Remove X?": its tables stay; its files in /data may go too. */
export function RemoveConfirm({
  p,
  busy,
  onYes,
  onNo,
}: {
  p: InstalledPlugin;
  busy: boolean;
  onYes: (data: "keep" | "delete") => void;
  onNo: () => void;
}) {
  const [drop, setDrop] = useState(false);
  return (
    <Confirm
      busy={busy}
      yes="Remove"
      text={
        <>
          Remove {titleOf(p)}? Its tables in keel's database stay.
          <label className="chk">
            <input
              type="checkbox"
              checked={drop}
              onChange={(e) => setDrop(e.target.checked)}
            />{" "}
            Also delete its files in /data
          </label>
        </>
      }
      onNo={onNo}
      onYes={() => onYes(drop ? "delete" : "keep")}
    />
  );
}

/** A panel with a named region (the tests and screen readers find it by its title). */
function Section({
  id,
  title,
  extra,
  children,
  body = true,
}: {
  id: string;
  title: string;
  extra?: ReactNode;
  children: ReactNode;
  body?: boolean;
}) {
  return (
    <section className="panel" aria-labelledby={id}>
      <div className="panel-head">
        <h2 id={id}>{title}</h2>
        {extra}
      </div>
      {body ? <div className="panel-body">{children}</div> : children}
    </section>
  );
}

const bytes = (n?: number) =>
  !n
    ? null
    : n >= 1024 * 1024
      ? `${(n / 1024 / 1024).toFixed(1)} MB`
      : `${Math.max(1, Math.round(n / 1024))} KB`;

const repoText = (url: string) => url.replace(/^https?:\/\//, "");

// ---------- the page ----------

export function PluginDetailPage({
  name,
  view,
  back,
  onBack,
  onInstall,
}: {
  name: string;
  view: Loaded<PluginsView>;
  /** the tab the person came from: the crumb's middle step */
  back: "installed" | "market" | "sources";
  onBack: (tab: "installed" | "market" | "sources") => void;
  onInstall: (name: string) => void;
}) {
  const { health, pid } = useApp();
  // v0.17.1 a plugin each project turns on: what it adds (Tools › Plugins' card said it) and its Projects section
  const perProject = useProjectPlugins(pid).data?.find((x) => x.name === name);
  const r = useLoad(`market-plugin:${name}`, () => marketApi.plugin(name), {
    live: false,
  });
  const { busy, err, actions } = usePluginAct(view.reload);
  const [removing, setRemoving] = useState(false);
  const p: MarketPlugin | null = r.data;
  const mine = view.data?.plugins.find((x) => x.name === name);
  const titles = new Map<string, string>(
    (view.data?.plugins ?? []).map((x) => [x.name, titleOf(x)]),
  );
  for (const it of p ? planOf(p) : [])
    if (it.title && !titles.has(it.name)) titles.set(it.name, it.title);
  const crumb = (
    <nav className="mk-crumb" aria-label="Breadcrumb">
      <a href="#/plugins" onClick={() => onBack("installed")}>
        Plugins
      </a>
      <span aria-hidden="true">›</span>
      <a href="#/plugins" onClick={() => onBack(back)}>
        {back === "installed"
          ? "Installed"
          : back === "sources"
            ? "Sources and rules"
            : "Marketplace"}
      </a>
      <span aria-hidden="true">›</span>
      <span aria-current="page">{p?.title ?? mine?.title ?? name}</span>
    </nav>
  );
  if (!p && (r.loading || (!r.error && !r.data)) && !mine)
    return (
      <>
        {crumb}
        <Loading what="Reading the plugin" />
      </>
    );
  if (!p && !mine)
    return (
      <>
        {crumb}
        {view.data ? (
          <ErrorBox
            error={r.error ?? { message: `No plugin ${name}.` }}
            onRetry={() => void r.reload()}
          />
        ) : (
          <Loading what="Reading the plugin" />
        )}
      </>
    );

  // what keel knows: the catalog's entry, else what the image (installed.json) says
  const title = p?.title ?? (mine ? titleOf(mine) : name);
  const pub = p
    ? publisherOf(p)
    : {
        name: mine?.publisher ?? "",
        verified: (mine?.publisher ?? "") === "keel",
      };
  const trust = (p?.trust ?? mine?.trust ?? undefined) as string | undefined;
  const version = p ? newestVersion(p) : mine?.version;
  const inst = p
    ? (installedVersion(p) ?? mine?.version ?? (mine ? "" : null))
    : (mine?.version ?? "");
  const upd = mine ? updateOf(mine) : p ? updateOf(p) : null;
  const perms = p ? permissionsOf(p) : mine?.permissions;
  const needs = p ? needsOf(p) : Object.keys(mine?.needs ?? {});
  const v = p?.versions?.find((x) => x.version === version);
  const keelRange = v?.requires?.keel;
  const revoked = revokedText(mine?.revoked ?? p?.revoked);
  const parts = mine?.parts?.length
    ? mine.parts
    : (TRUST_PARTS[trust ?? ""] ?? []);
  const adds: [string, string][] = [
    ...parts.map((x): [string, string] => [x, PART_WORDS[x] ?? x]),
    ...piecesOf(name),
  ];
  const a = mine ? actions(mine) : null;
  const on = mine ? mine.on !== false : false;
  const known = !!p;

  const main =
    inst !== null && mine ? (
      <>
        {(mine.on === false ||
          (mine.status && mine.status !== "loaded") ||
          problemsOf(mine).length > 0) && (
          <StatusOf p={mine} problems={problemsOf(mine).length > 0} />
        )}
        <Pill tone="ok">Installed{inst ? ` ${inst}` : ""}</Pill>
        {upd && (
          <button
            className="btn primary"
            type="button"
            disabled={busy === name}
            onClick={() =>
              void a!.update(
                typeof mine.update === "string" ? mine.update : undefined,
              )
            }
          >
            Update to {upd}
          </button>
        )}
        {mine.previous && (
          <button
            className="btn"
            type="button"
            disabled={busy === name}
            onClick={() => void a!.rollback()}
          >
            Roll back to {mine.previous}
          </button>
        )}
        <button
          className="btn"
          type="button"
          disabled={busy === name}
          onClick={() => void a!.setOn(!on)}
        >
          {on ? "Turn off" : "Turn on"}
        </button>
        {canRemove(mine) && (
          <button
            className="btn ghost mk-danger"
            type="button"
            disabled={busy === name}
            onClick={() => setRemoving(true)}
          >
            Remove
          </button>
        )}
      </>
    ) : inst !== null ? (
      <Pill tone="ok">Installed{inst ? ` ${inst}` : ""}</Pill>
    ) : (
      <button
        className="btn primary"
        type="button"
        disabled={!!p?.refused || p?.fits === false}
        onClick={() => onInstall(name)}
      >
        Install{version ? ` ${version}` : ""}
      </button>
    );

  return (
    <div className="mk-detail">
      {crumb}
      <div className="mk-dhead">
        <PluginIcon
          name={name}
          title={title}
          icon={(p as { icon?: unknown } | null)?.icon}
          size="lg"
        />
        <div style={{ minWidth: 0 }}>
          <h1>
            {title}
            {isBeta(version) && <span className="tag warn">beta</span>}
          </h1>
          <div className="mk-meta">
            {pub.name && (
              <span className="mk-by">
                <Publisher name={pub.name} verified={pub.verified} />
              </span>
            )}
            {version && <span className="mono">{version}</span>}
            <TrustTag trust={trust} />
            {p?.repo && (
              <a
                className="mono mk-repo"
                href={p.repo}
                target="_blank"
                rel="noreferrer"
              >
                {repoText(p.repo)}
              </a>
            )}
          </div>
        </div>
        <div className="actions mk-dact">{main}</div>
      </div>
      {removing && mine && (
        <div className="mk-dconfirm">
          <RemoveConfirm
            p={mine}
            busy={busy === name}
            onNo={() => setRemoving(false)}
            onYes={(data) =>
              void a!.remove(data).then((ok) => {
                setRemoving(false);
                if (ok) onBack("installed");
              })
            }
          />
        </div>
      )}
      {err && <ErrorBox error={err} />}
      {revoked && (
        <p className="mk-note bad" role="note">
          This version was revoked: {revoked}
        </p>
      )}
      {p?.refused && inst === null && (
        <ErrorBox
          error={{
            message: p.refused.error,
            hint: p.refused.hint ?? undefined,
          }}
        />
      )}
      {!known && (
        <p className="mk-note" role="note">
          No catalog lists {title} yet: this is what keel knows from{" "}
          {mine?.from === "image" ? "its image" : "the copy it has"}.
        </p>
      )}
      <div className="mk-dgrid">
        <div className="mk-stack">
          <Section id="mk-about" title="About">
            {(p?.summary ?? mine?.summary) && (
              <p className="mk-about">{p?.summary ?? mine?.summary}</p>
            )}
            {adds.length > 0 ? (
              <ul className="mk-adds" aria-label="What it brings">
                {adds.map(([k, t], i) => (
                  <li key={i}>
                    <span className="tag">{k}</span>
                    <span>{t}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="sub" style={{ margin: 0 }}>
                {TRUST[trust ?? ""]?.about ?? "keel does not know its parts yet."}
              </p>
            )}
            {perProject && <PluginAdds plugin={perProject} />}
          </Section>
          {mine && <PluginProjects name={name} />}
          <Section
            id="mk-versions"
            title="Versions"
            extra={<span className="sub">Newest first</span>}
            body={false}
          >
            <div className="table-wrap">
              <table className="mk-table mk-vtable">
                <thead>
                  <tr>
                    <th>Version</th>
                    <th>Works with</th>
                    <th>Released</th>
                    <th>Changes</th>
                  </tr>
                </thead>
                <tbody>
                  {p?.versions?.length ? (
                    p.versions.map((x) => {
                      const notes = (x as { changes?: unknown; notes?: unknown })
                        .changes ?? (x as { notes?: unknown }).notes;
                      return (
                        <tr key={x.version}>
                          <td className="mono">
                            {x.version}
                            {x.version === inst && (
                              <span className="sub"> · yours</span>
                            )}
                          </td>
                          <td className="mono">
                            {x.requires?.keel ? `keel ${x.requires.keel}` : "—"}
                          </td>
                          <td className="num sub">{x.released ?? "—"}</td>
                          <td>
                            {x.revoked ? (
                              <Pill
                                tone="bad"
                                title={
                                  typeof x.revoked === "string"
                                    ? x.revoked
                                    : undefined
                                }
                              >
                                revoked
                              </Pill>
                            ) : null}
                            {x.revoked && typeof x.revoked === "string" && (
                              <span className="sub"> {x.revoked}</span>
                            )}
                            {typeof notes === "string" && notes && (
                              <span>{notes}</span>
                            )}
                            {x.fits === false && (
                              <div className="sub">
                                {x.why_not ?? "does not fit this keel"}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td className="mono">{mine?.version ?? "—"}</td>
                      <td className="mono">—</td>
                      <td className="sub">—</td>
                      <td className="sub">
                        {mine?.from === "image"
                          ? "The version in keel's image."
                          : "The version keel has."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Section>
          {!!p?.checks?.length && (
            <Section id="mk-checks" title="Checks keel runs before install">
              <div className="mk-checklist">
                {p.checks.map((c, i) => (
                  <div key={i}>
                    <span className="mk-ok" aria-hidden="true">
                      ✓
                    </span>
                    <span>{typeof c === "string" ? c : (c.text ?? c.name)}</span>
                  </div>
                ))}
              </div>
            </Section>
          )}
        </div>
        <div className="mk-stack">
          <Section
            id="mk-perms"
            title="Permissions"
            extra={
              <span className="sub">
                {permissionLines(perms).length} asked
              </span>
            }
          >
            <PermissionList permissions={perms} />
            {trust === "code" && (
              <p className="mk-quote">
                A plugin that runs code is trusted like keel itself. Install it
                only from a publisher you trust.
              </p>
            )}
          </Section>
          <Section id="mk-needs" title="Needs">
            <div className="mk-checklist">
              <div>
                <span className="mk-ok" aria-hidden="true">
                  ✓
                </span>
                <span>
                  keel core{" "}
                  {keelRange && <span className="mono">{keelRange}</span>}
                  {health?.version && (
                    <>
                      {" "}
                      · you have{" "}
                      <span className="mono">
                        {health.version.replace(/^v/, "")}
                      </span>
                    </>
                  )}
                </span>
              </div>
              {needs.map((n) => {
                const there = view.data?.plugins.some((x) => x.name === n);
                return (
                  <div key={n}>
                    {there ? (
                      <span className="mk-ok" aria-hidden="true">
                        ✓
                      </span>
                    ) : (
                      <span className="tag warn" aria-hidden="true">
                        +
                      </span>
                    )}
                    <span>
                      <b>{titles.get(n) ?? n}</b>{" "}
                      <span className="sub">
                        {there ? "installed" : "will be installed too"}
                      </span>
                    </span>
                  </div>
                );
              })}
              {!needs.length && (
                <p className="sub" style={{ margin: 0 }}>
                  No other plugin.
                </p>
              )}
            </div>
            <dl className="mk-kv">
              {bytes(v?.size) && (
                <>
                  <dt>Size</dt>
                  <dd className="mono">{bytes(v?.size)}</dd>
                </>
              )}
              <dt>After install</dt>
              <dd>
                {trust === "content"
                  ? "Ready at once, no restart"
                  : "keel restarts its api and engine (about 30 s)"}
              </dd>
              {(version || mine?.version) && (
                <>
                  <dt>Goes to</dt>
                  <dd className="mono">
                    plugins/store/{name}/{inst || version}/
                  </dd>
                </>
              )}
            </dl>
          </Section>
        </div>
      </div>
    </div>
  );
}
