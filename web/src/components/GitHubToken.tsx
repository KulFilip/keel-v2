// v0.10.0 Connections › GitHub: the token keel's Git plugin pushes and opens pull requests with (its own, not the
// Copilot login). Saved encrypted; only its last 3 characters are ever shown. It is keel's core (step 3): a flow's ship
// step opens the pull request with it too, with or without the Git plugin (corePages.ts puts it in Connections).
// v0.18.30 "Sign in with GitHub": a one-time code and a link (the device flow, like the Copilot login) instead of a
// pasted token; the result is who is connected (login, scopes, host). Pasting a token stays as the second way.

import { useEffect, useRef, useState } from "react";
import { api, errorParts, type GitHubLoginView } from "../api";
import { useApp, useLoad } from "../state";
import { Section } from "./page";
import { Pill } from "./ui";

const ACTIVE = ["starting", "waiting"];

export function GitHubSection() {
  const gh = useLoad("github", () => api.github(), { live: false });
  const { toast } = useApp();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [host, setHost] = useState("github.com");
  const [login, setLogin] = useState<GitHubLoginView | null>(null);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  // poll while the sign-in waits for the person
  useEffect(() => {
    if (!login || !ACTIVE.includes(login.status)) return;
    const t = window.setTimeout(() => {
      api.githubLoginState(login.id).then((v) => live.current && setLogin(v), () => undefined);
    }, 2000);
    return () => window.clearTimeout(t);
  }, [login]);
  useEffect(() => {
    if (login?.status === "done") void gh.reload();
  }, [login?.status]);

  const signIn = async () => {
    setBusy(true);
    try {
      setLogin(await api.githubLogin(host.trim() || "github.com"));
    } catch (e) {
      setLogin(null);
      toast(errorParts(e).message);
    } finally {
      setBusy(false);
    }
  };
  const cancel = () => {
    if (login && ACTIVE.includes(login.status)) void api.githubLoginCancel(login.id).catch(() => undefined);
    setLogin(null);
  };
  const signOut = async () => {
    try {
      await api.githubSignOut();
      setLogin(null);
      toast("Signed out of GitHub. keel's token is removed.");
      void gh.reload();
    } catch (e) {
      toast(errorParts(e).message);
    }
  };
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.setSecret("GITHUB_REPO_TOKEN", value);
      setValue("");
      toast(`GitHub token saved (${r.hint}).`);
      void gh.reload();
    } catch (e) {
      toast(errorParts(e).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    try {
      await api.deleteSecret("GITHUB_REPO_TOKEN");
      toast("GitHub token removed.");
      void gh.reload();
    } catch (e) {
      toast(errorParts(e).message);
    }
  };
  const copy = (text: string) => navigator.clipboard?.writeText(text).then(() => toast("Copied."), () => toast("Select the text to copy it."));
  const waiting = !!login && ACTIVE.includes(login.status);
  const who = gh.data?.login;
  return (
    <Section
      title="GitHub"
      sub="The token keel pushes branches and opens pull requests with (Git plugin, and a flow's PR step). It needs repo access."
    >
      <div className="panel">
        <div className="panel-body gh-box">
          <div className="gh-row">
            {gh.data?.set ? (
              <Pill tone="ok">
                {who
                  ? `connected as ${who}${gh.data.scopes?.length ? ` · ${gh.data.scopes.join(", ")}` : ""} · ${gh.data.host ?? "github.com"}`
                  : `token set${gh.data.hint ? ` ${gh.data.hint}` : ""}${gh.data.from === "env" ? " (from the environment)" : ""}`}
              </Pill>
            ) : (
              <Pill tone="idle">no token</Pill>
            )}
            {gh.data?.from === "keel" && who && (
              <button type="button" className="btn sm ghost" onClick={() => void signOut()}>Sign out</button>
            )}
          </div>
          <div className="gh-row">
            <input
              className="inline-input"
              aria-label="GitHub host"
              placeholder="github.com"
              autoComplete="off"
              value={host}
              disabled={waiting}
              onChange={(e) => setHost(e.target.value)}
              style={{ maxWidth: 220 }}
            />
            <button type="button" className="btn sm primary" disabled={busy || waiting} onClick={() => void signIn()}>
              Sign in with GitHub
            </button>
            <span className="sub">A GitHub Enterprise host works too.</span>
          </div>
          {login && (
            <ol className="steps" aria-label="GitHub sign-in">
              {login.url && ACTIVE.includes(login.status) && (
                <li>
                  <span>Open this page:</span>
                  <div className="row">
                    <a className="btn sm primary" href={login.url} target="_blank" rel="noreferrer">Open GitHub</a>
                    <button type="button" className="btn sm ghost" onClick={() => copy(login.url!)}>Copy link</button>
                  </div>
                </li>
              )}
              {login.code && ACTIVE.includes(login.status) && (
                <li>
                  <span>Type this code on that page:</span>
                  <div className="row">
                    <b className="devcode">{login.code}</b>
                    <button type="button" className="btn sm ghost" onClick={() => copy(login.code!)}>Copy code</button>
                  </div>
                </li>
              )}
              <li>
                <span role="status" className={login.status === "done" ? "okc" : login.status === "failed" ? "badc" : "sub"}>
                  {login.status === "done"
                    ? `✓ connected as ${login.login ?? "GitHub"}${login.scopes.length ? ` · ${login.scopes.join(", ")}` : ""} · ${login.host}`
                    : login.status === "failed" ? `✕ ${login.message}` : `… ${login.message}`}
                </span>
                {waiting && <button type="button" className="btn sm ghost" onClick={cancel}>Cancel</button>}
              </li>
            </ol>
          )}
          <div className="gh-row">
            <label htmlFor="gh-token" className="sub">or paste a token</label>
            <input
              type="password"
              className="inline-input"
              id="gh-token"
              aria-label="GitHub token"
              placeholder="ghp_… or github_pat_…"
              autoComplete="off"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <button
              type="button"
              className="btn sm primary"
              disabled={busy || !value.trim()}
              onClick={() => void save()}
            >
              Save
            </button>
            {gh.data?.from === "keel" && !who && (
              <button
                type="button"
                className="btn sm ghost"
                onClick={() => void remove()}
              >
                Remove
              </button>
            )}
          </div>
        </div>
      </div>
    </Section>
  );
}
