// keel 0.18.28 a stack brings its language support: when a project opens (and when one of its stacks changes: the
// api's project.changed with stacks), the dashboard loads exactly the highlight.js languages its stacks name.

import { api } from "../api";
import { setStackLanguages } from "./highlight";

let asked = 0;

/** Load the project's stack languages (a later call wins over an earlier one still on its way). */
export async function loadProjectLanguages(pid: string | null): Promise<void> {
  const mine = ++asked;
  if (!pid) {
    setStackLanguages([]);
    return;
  }
  try {
    const r = await api.languages(pid);
    if (mine === asked) setStackLanguages(r.languages ?? []);
  } catch {
    // an older api without the route: the static map still colours the usual files
  }
}
