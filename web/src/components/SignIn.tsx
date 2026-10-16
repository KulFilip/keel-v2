// v0.17.5 the sign-in screen: this browser has no sign-in for this keel yet (or it was reset, or the link was used up).
// keel has no password: `keel2 open` in a terminal opens keel signed in (api auth/WebSignIn).

import { useState } from "react";
import { signInDone, type SignInState } from "../signIn";
import { EmptyState } from "./EmptyState";

export function SignIn({ state }: { state: SignInState }) {
  const [checking, setChecking] = useState(false);
  const [still, setStill] = useState(false);

  const retry = async () => {
    setChecking(true);
    setStill(false);
    try {
      const res = await fetch("/api/web/me", { credentials: "same-origin", headers: { "X-Keel-Web": "1" } });
      if (res.ok) {
        signInDone();
        // a fresh start of the app, without ?signin=… in the address
        window.location.replace(window.location.pathname + window.location.hash);
        return;
      }
    } catch {
      /* keel is not reachable: say it is still not signed in */
    }
    setStill(true);
    setChecking(false);
  };

  return (
    <main className="signin" aria-label="Sign in to keel">
      <EmptyState
        title={state.reason === "expired" ? "This sign-in link was already used" : "Sign in to keel"}
        action={
          <button className="btn primary" type="button" onClick={retry} disabled={checking}>
            {checking ? "Checking…" : "Try again"}
          </button>
        }
      >
        Run <code>keel2 open</code> in a terminal. It opens keel in your browser, signed in. A sign-in link works once.
      </EmptyState>
      {still && (
        <p className="signin-still" role="status">
          This browser is still not signed in. Use the tab that <code>keel2 open</code> opened, or run{" "}
          <code>keel2 open --print</code> and paste the link here.
        </p>
      )}
    </main>
  );
}
