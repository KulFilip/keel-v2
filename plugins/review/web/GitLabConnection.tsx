// v0.14.0 Connections › GitLab: the server (gitlab.com or your company's) and a personal access token with the api and
// read_user scopes, for the Code Review plugin's merge requests. The token is saved encrypted; only its last 3
// characters are ever shown. A project is on GitLab when its origin remote names this server.
// keel 0.18.57 Settings › Connections: one card, the state on the right, a refused token says why under the fields.

import { useState } from "react";
import { errorParts, Note, TonePill, useApp, useLoad } from "@keel/web-sdk";
import { reviewApi } from "./reviewApi";

export function GitLabSection() {
  const gl = useLoad("gitlab", () => reviewApi.gitlab(), { live: false });
  const { toast } = useApp();
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const shownUrl = url || gl.data?.url || "";
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await reviewApi.saveGitlab(shownUrl, token || undefined);
      setToken("");
      setUrl("");
      toast(`GitLab saved: ${r.host}${r.hint ? ` (${r.hint})` : ""}.`);
      gl.setData(r);
    } catch (e) {
      const p = errorParts(e);
      setErr(p.hint ? `${p.message} ${p.hint}` : p.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    try {
      gl.setData(await reviewApi.clearGitlab());
      toast("GitLab removed.");
    } catch (e) {
      toast(errorParts(e).message);
    }
  };
  const on = !!gl.data?.set;
  return (
    <section className="ss-cardp" aria-labelledby="c-gl" data-testid="gitlab">
      <div className="ss-sechead">
        <div>
          <h2 id="c-gl" className="ss-h2 ss-title-row">GitLab <span className="ss-tag acc">every project</span></h2>
          <p className="ss-sub">For merge requests in the Code Review plugin: the server address and a token with the api and read_user scopes (GitLab › Preferences › Access tokens).</p>
        </div>
        {gl.data && (on
          ? <TonePill tone="ok">{`connected to ${gl.data.host}${gl.data.hint ? ` · token ${gl.data.hint}` : ""}`}</TonePill>
          : <TonePill tone="off">not connected</TonePill>)}
      </div>
      <div className="ss-fields">
        <label className="ss-label" htmlFor="gl-url">GitLab server
          <input type="url" className="ss-input mono" id="gl-url" placeholder="https://gitlab.yourcompany.com" value={shownUrl} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label className="ss-label" htmlFor="gl-token">GitLab token
          <input type="password" className="ss-input mono" id="gl-token" placeholder={on ? "token (leave empty to keep it)" : "glpat-…"} autoComplete="off"
            aria-invalid={!!err} value={token} onChange={(e) => { setToken(e.target.value); setErr(null); }} />
        </label>
        <button type="button" className="ss-btn sm p" style={{ minHeight: 40 }} disabled={busy || !shownUrl.trim() || (!on && !token.trim())} onClick={() => void save()}>Save</button>
        {on && <button type="button" className="ss-btn sm" style={{ minHeight: 40 }} onClick={() => void remove()}>Remove</button>}
      </div>
      {err && <Note tone="err" role="alert">{err}</Note>}
      <span className="ss-help">Saved encrypted; only its last 3 characters are ever shown. A project is on GitLab when its origin remote names this server.</span>
    </section>
  );
}
