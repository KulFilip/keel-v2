import { useEffect, useMemo, useState } from "react";
import { refreshFeatures } from "../../addons";
import { errorParts } from "../../api";
import { Drawer, ErrorBox, Loading, Pill } from "../../components/ui";
import { PermissionList, TrustTag } from "../../components/Permissions";
import {
  liveNotes,
  loadsWeb,
  marketApi,
  newestVersion,
  permissionsOf,
  planOf,
  publisherOf,
  turnOnOf,
  type ChangeAnswer,
  type MarketPlugin,
  type Permissions,
  type PluginsView,
} from "../../marketplaceApi";
import { useApp } from "../../state";
import { type Err } from "../PluginDetail";
import type { InstallPlan } from "./PluginsPage";

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

export function InstallDialog({
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
    // v0.17.1 a web or content-only plugin works at once; anything else after the restart
    let waits = false;
    let web = false;
    const note = (a: ChangeAnswer) => {
      const got = Object.values(liveNotes(a));
      waits ||= !a.live || got.includes("restart");
      web ||= loadsWeb(a);
    };
    try {
      for (const name of plan.install) {
        if (unlisted.has(name)) continue;
        // a set's earlier install may have brought this one in already
        const now = await marketApi.installed();
        if (now.plugins.some((p) => p.name === name)) continue;
        setState((s) => ({ ...s, [name]: "installing" }));
        const it = items?.find((x) => x.name === name);
        try {
          note(
            await marketApi.install(
              name,
              plan.install.length === 1 ? it?.version : undefined,
            ),
          );
        } catch (e) {
          setState((s) => ({ ...s, [name]: "failed" }));
          throw e;
        }
        setState((s) => ({ ...s, [name]: "done" }));
        done++;
      }
      for (const name of turnOn) note(await marketApi.setOn(name, true));
      if (web) void refreshFeatures();
      const names = [
        ...(items ?? [])
          .filter((x) => x.target && !x.problem)
          .map((x) => x.title),
        ...turnOn,
      ];
      toast(
        names.length === 1 && done === 1
          ? `${names[0]} is installed. ${waits ? "Restart keel to use it." : "It works now."}`
          : `The plugins are ready. ${waits ? "Restart keel to use them." : "They work now."}`,
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
