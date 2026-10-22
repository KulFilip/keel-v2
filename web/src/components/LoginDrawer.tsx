// The one right-side panel that walks the person through a sign-in: what happens, the link, the code, waiting, saved.
// Connections › providers (Claude, Codex, Copilot) and Connections › GitHub both use it. They differ only in an adapter
// (start / poll / cancel) and a few small slots, so the steps, the copy buttons and the error handling exist once.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { errorParts } from "../api";
import { useApp } from "../state";
import { Drawer } from "./ui";

/** What every login answers with, whatever endpoint it comes from. */
export type LoginBase = { id: string; status: string; url?: string | null; code?: string | null; message: string };

export type LoginAdapter<V extends LoginBase> = {
  start: () => Promise<V>;
  poll: (id: string) => Promise<V>;
  cancel: (id: string) => Promise<unknown>;
};

/** Handed to a slot so it can change the login or show an error in the drawer. */
export type LoginCtx<V extends LoginBase> = { login: V | null; setLogin: (v: V) => void; setErr: (m: string | null) => void };

const TERMINAL = ["done", "failed", "cancelled"];

export function copyText(text: string, toast: (m: string) => void) {
  navigator.clipboard?.writeText(text).then(() => toast("Copied."), () => toast("Select the text to copy it."));
}

export function LoginDrawer<V extends LoginBase>({ title, intro, note, adapter, doneText, onDone, onClose, before, openHint, steps, status, tabs }: {
  title: string;
  intro: string;
  /** A hint under the intro (for example "authorize your organisation"). */
  note?: ReactNode;
  adapter: LoginAdapter<V>;
  /** The line shown when the login is saved. */
  doneText: (v: V) => string;
  /** Runs once when the login is saved. */
  onDone: (v: V) => void;
  onClose: () => void;
  /** Fields shown before the login starts (the GitHub host). */
  before?: (login: V | null) => ReactNode;
  /** Added to "Open this page", for example " and sign in with your Claude account". */
  openHint?: string;
  /** Extra steps between the code and the status line (Claude's "paste the code" step). */
  steps?: (ctx: LoginCtx<V>) => ReactNode;
  /** Shown under the status line (the connection test). */
  status?: ReactNode;
  /** A second tab ("Paste a token"). Without it the drawer has just the sign-in. */
  tabs?: ReactNode;
}) {
  const { toast } = useApp();
  const [way, setWay] = useState<"here" | "paste">("here");
  const [login, setLogin] = useState<V | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  // poll while the login runs; one failed poll is only skipped: the next one is armed again (same interval)
  const [again, setAgain] = useState(0);
  useEffect(() => {
    if (!login || TERMINAL.includes(login.status)) return;
    const t = window.setTimeout(() => {
      adapter.poll(login.id).then(
        (v) => live.current && setLogin(v),
        () => live.current && setAgain((n) => n + 1),
      );
    }, 2000);
    return () => window.clearTimeout(t);
  }, [login, again]);

  // when it is saved
  useEffect(() => {
    if (login?.status === "done") onDone(login);
  }, [login?.status]);

  const start = async () => {
    setBusy(true); setErr(null);
    try { setLogin(await adapter.start()); } catch (e) { setErr(errorParts(e).message); } finally { setBusy(false); }
  };
  const close = () => {
    if (login && !TERMINAL.includes(login.status)) void adapter.cancel(login.id).catch(() => undefined);
    onClose();
  };

  return (
    <Drawer title={title} onClose={close} footer={<button className="btn" type="button" onClick={close}>Close</button>}>
      {tabs !== undefined && (
        <div className="tabs" role="tablist">
          <button role="tab" type="button" aria-selected={way === "here"} onClick={() => setWay("here")}>Log in here</button>
          <button role="tab" type="button" aria-selected={way === "paste"} onClick={() => setWay("paste")}>Paste a token</button>
        </div>
      )}
      {way === "here" ? (
        <div className="grid" style={{ gap: 12 }}>
          <p className="sub" style={{ margin: 0 }}>{intro}</p>
          {note && <p className="sub" style={{ margin: 0 }}>{note}</p>}
          {before?.(login)}
          {(!login || ["failed", "cancelled"].includes(login.status)) && (
            <button className="btn primary" type="button" onClick={start} disabled={busy}>{busy ? "Starting…" : login ? "Start again" : "Start login"}</button>
          )}
          {login && (
            <ol className="steps">
              {login.url && (
                <li>
                  <span>Open this page{openHint ?? ""}:</span>
                  <div className="row">
                    <a className="btn sm primary" href={login.url} target="_blank" rel="noreferrer">Open {new URL(login.url).host}</a>
                    <button className="btn sm ghost" type="button" onClick={() => copyText(login.url!, toast)}>Copy link</button>
                  </div>
                </li>
              )}
              {login.code && (
                <li>
                  <span>Type this code on that page:</span>
                  <div className="row"><b className="devcode">{login.code}</b><button className="btn sm ghost" type="button" onClick={() => copyText(login.code!, toast)}>Copy code</button></div>
                </li>
              )}
              {steps?.({ login, setLogin, setErr })}
              <li>
                <span role="status" className={login.status === "done" ? "okc" : login.status === "failed" ? "badc" : "sub"}>
                  {login.status === "done" ? `✓ ${doneText(login)}` : login.status === "failed" ? `✕ ${login.message}` : `… ${login.message}`}
                </span>
                {status}
              </li>
            </ol>
          )}
          {err && <span className="badc">{err}</span>}
        </div>
      ) : tabs}
    </Drawer>
  );
}
