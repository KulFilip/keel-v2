// v0.17.5 keel's api proves every caller (api auth/LocalAuth). The browser signs in through a link keel2 opens
// (`keel2 open`): it sets a cookie for this keel. When the api answers 401 with `X-Keel-Auth: sign-in` (no cookie yet,
// a reset key, an old tab after the update), the app shows the sign-in screen instead of failing page by page.

import { useSyncExternalStore } from "react";

export type SignInState = { needed: boolean; reason: "none" | "signed-out" | "expired" };

const fromUrl = (): SignInState => {
  try {
    return new URLSearchParams(window.location.search).get("signin") === "expired"
      ? { needed: true, reason: "expired" }
      : { needed: false, reason: "none" };
  } catch {
    return { needed: false, reason: "none" };
  }
};

let state: SignInState = fromUrl();
const listeners = new Set<() => void>();

const set = (next: SignInState) => {
  if (next.needed === state.needed && next.reason === state.reason) return;
  state = next;
  listeners.forEach((l) => l());
};

/** The api said this browser is not signed in. */
export const signInNeeded = () => set({ needed: true, reason: state.reason === "expired" ? "expired" : "signed-out" });

/** Back to normal (tests; and after "Try again" found the browser signed in). */
export const signInDone = () => set({ needed: false, reason: "none" });

export const useSignIn = (): SignInState =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
