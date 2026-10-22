import { useEffect, useRef } from "react";
import { ErrorBox, Loading, Panel, Pill } from "../../components/ui";
import { marketApi, setsOf, type PluginsView } from "../../marketplaceApi";
import { useLoad } from "../../state";
import type { InstallPlan } from "./PluginsPage";

// ---------- Start with a set ----------

export function SetOffer({
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
