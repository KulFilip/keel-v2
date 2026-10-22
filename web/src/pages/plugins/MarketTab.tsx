import { useMemo, useState } from "react";
import { refreshFeatures } from "../../addons";
import { errorParts } from "../../api";
import { ErrorBox, Loading, Pill } from "../../components/ui";
import { TrustTag } from "../../components/Permissions";
import {
  TRUST,
  hitsOf,
  installedVersion,
  liveNotes,
  loadsWeb,
  marketApi,
  needsOf,
  publisherOf,
  revokedText,
  sourceStatusOf,
  updateOf,
  type InstalledPlugin,
  type MarketHit,
  type PluginsView,
} from "../../marketplaceApi";
import { useApp, useLoad } from "../../state";
import { titleOf, type Err } from "../PluginDetail";
import { useDebounced } from "../../hooks";
import { CHIPS, PluginIcon, Publisher, fromKeel, inChip, isBeta, type Chip } from "../pluginLook";

// ---------- Marketplace ----------


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

export function MarketTab({
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
      const a = await marketApi.update(h.name, to || undefined);
      const note = liveNotes(a)[h.name];
      toast(
        note === "applied"
          ? `${h.title ?? h.name} is updated. It works now.`
          : note === "reload"
            ? `${h.title ?? h.name} is updated. Reload the page to use it.`
            : `${h.title ?? h.name} is updated. Restart keel to use it.`,
      );
      if (loadsWeb(a)) void refreshFeatures();
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
              <a className="mk-card-link" href={`#/plugins/${encodeURIComponent(h.name)}`}>
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
