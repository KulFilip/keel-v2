import { useState } from "react";
import { errorParts } from "../../api";
import { Confirm, ErrorBox } from "../../components/ui";
import { marketApi, pendingOf, type LiveNote, type PluginsView } from "../../marketplaceApi";
import { useApp } from "../../state";
import { type Err } from "../PluginDetail";

// ---------- the restart banner, and each waiting row's Restart now ----------

/** Restart keel now (POST /api/plugins/restart {now: true}); `restarting` once keel goes. */
function useRestartNow(onDone: () => void) {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Err>(null);
  const [restarting, setRestarting] = useState(false);
  const restart = async (now: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      const a = await marketApi.restart(now);
      if (a.restarting) {
        setRestarting(true);
        toast("keel restarts now. This page comes back in about 30 seconds.");
      } else toast("keel restarts by itself when no agent step runs.");
      onDone();
      return true;
    } catch (e) {
      setErr(errorParts(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, err, restarting, restart };
}

/** A row whose change waits: "applies after restart" and Restart now (the banner above says the same for all). */
export function RowRestart({
  title,
  view,
  onDone,
}: {
  title: string;
  view: PluginsView;
  onDone: () => void;
}) {
  const r = view.restart;
  const { busy, err, restarting, restart } = useRestartNow(onDone);
  const [ask, setAsk] = useState(false);
  return (
    <div className="mk-rownote wait" aria-label={`${title}: applies after restart`}>
      <span>{restarting ? "keel is restarting…" : "applies after restart"}</span>
      {restarting ? null : r?.supervised === false ? (
        <span className="sub">
          restart by hand: <code>keel2 restart</code>
        </span>
      ) : ask ? (
        <Confirm
          text={`${r.running} agent step${r.running === 1 ? "" : "s"} run now. They stop, and go on after the restart.`}
          yes="Restart anyway"
          busy={busy}
          onYes={() => void restart(true).then(() => setAsk(false))}
          onNo={() => setAsk(false)}
        />
      ) : (
        <button
          className="btn sm warn"
          type="button"
          disabled={busy}
          onClick={() => (r?.running > 0 ? setAsk(true) : void restart(true))}
        >
          Restart now
        </button>
      )}
      {err && (
        <span className="badc sub">
          {err.message}
          {err.hint ? ` ${err.hint}` : ""}
        </span>
      )}
    </div>
  );
}

/** What a row says after its change applied without a restart. */
export function AppliedNote({ note }: { note: LiveNote }) {
  if (note === "applied")
    return (
      <div className="mk-rownote ok" role="status">
        applied
      </div>
    );
  if (note === "reload")
    return (
      <div className="mk-rownote ok" role="status">
        <span>
          applied —{" "}
          <button
            className="linkbtn"
            type="button"
            onClick={() => location.reload()}
          >
            reload the page
          </button>
        </span>
      </div>
    );
  return null;
}

export function RestartBanner({
  view,
  onDone,
}: {
  view: PluginsView;
  onDone: () => void;
}) {
  const r = view.restart;
  const { busy, err, restarting: gone, restart: go } = useRestartNow(onDone);
  const [ask, setAsk] = useState(false);
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
    await go(now);
    setAsk(false);
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
