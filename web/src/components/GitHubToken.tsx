// v0.10.0 Connections › GitHub: the token keel's Git plugin pushes and opens pull requests with (its own, not the
// Copilot login). Saved encrypted; only its last 3 characters are ever shown. It is keel's core (step 3): a flow's ship
// step opens the pull request with it too, with or without the Git plugin (corePages.ts puts it in Connections).
// v0.18.30 "Sign in with GitHub": a one-time code and a link (the device flow, like the Copilot login) instead of a
// pasted token; the result is who is connected (login, scopes, host). Pasting a token stays as the second way.
// v0.18.31 the sign-in opens the same right-side panel as the providers' logins (LoginDrawer); the card shows only state.

import { useState } from "react";
import { api, errorParts, type GitHubLoginView } from "../api";
import { useApp, useLoad } from "../state";
import { LoginDrawer, type LoginAdapter } from "./LoginDrawer";
import { Section } from "./page";
import { Pill } from "./ui";

/** The drawer for "Sign in with GitHub": the shared login panel with the GitHub host field and the SSO hint. */
function GitHubLoginHelper({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [host, setHost] = useState("github.com");
  const adapter: LoginAdapter<GitHubLoginView> = {
    start: () => api.githubLogin(host.trim() || "github.com"),
    poll: (id) => api.githubLoginState(id),
    cancel: (id) => api.githubLoginCancel(id),
  };
  return (
    <LoginDrawer
      title="Set up GitHub login"
      intro="keel asks GitHub for a one-time code. You open the link, type the code and allow access. keel saves the token by itself. A GitHub Enterprise host works too."
      note="If your organisation uses SSO, authorize it when GitHub asks."
      adapter={adapter}
      doneText={(v) => `connected as ${v.login ?? "GitHub"}${v.scopes.length ? ` · ${v.scopes.join(", ")}` : ""} · ${v.host}`}
      onDone={onSaved}
      onClose={onClose}
      before={(login) => (
        <div className="field">
          <label htmlFor="gh-host">GitHub host</label>
          <input id="gh-host" className="inline-input" placeholder="github.com" autoComplete="off" value={host}
            disabled={!!login && !["failed", "cancelled"].includes(login.status)} onChange={(e) => setHost(e.target.value)} />
        </div>
      )}
    />
  );
}

export function GitHubSection() {
  const gh = useLoad("github", () => api.github(), { live: false });
  const { toast } = useApp();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [helper, setHelper] = useState(false);

  const signOut = async () => {
    try {
      await api.githubSignOut();
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
  const who = gh.data?.login;
  return (
    <Section
      title="GitHub"
      sub="The token keel pushes branches and opens pull requests with (Git plugin, and a flow's PR step). It needs repo access."
    >
      {helper && <GitHubLoginHelper onClose={() => setHelper(false)} onSaved={() => void gh.reload()} />}
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
            <button type="button" className="btn sm primary" onClick={() => setHelper(true)}>
              Sign in with GitHub
            </button>
          </div>
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
