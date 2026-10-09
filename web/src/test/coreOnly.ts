// Tests: keel with only its core (step 6: the core image, or KEEL_PLUGINS=off), or with some plugins off. setup.ts loads
// every plugin, as the full image does; these take pages and slot pieces away for one test, and restorePlugins() (in an
// afterEach) puts them back in their order.
//
//   coreOnly()                     no plugin's page, and no plugin's piece in any slot (keel's own GitHub section stays)
//   withoutPages("wiki", "graph")  these plugins' pages only (a set without them)
//   withoutSlot(SLOTS.assistant)   a slot's pieces (all, or the ones with these ids)

import { SCREEN } from "../routes";
import {
  allPages,
  pageOf,
  registerPage,
  registerSlot,
  slotItems,
} from "../sdk/registry";
import { SLOTS } from "../sdk/slots";

const OWN = new Set<string>(Object.values(SCREEN));
let undo: (() => void)[] = [];

/** These pages go, as when their plugin is not loaded. */
export function withoutPages(...ids: string[]) {
  for (const id of ids) {
    const page = pageOf(id);
    if (!page) continue;
    // a copy takes its place, and the copy is taken away
    registerPage({ ...page })();
    undo.push(() => registerPage(page));
  }
}

/** A slot's pieces go (all of them, or the ones with these ids). */
export function withoutSlot(slot: string, ...ids: string[]) {
  for (const item of [...slotItems(slot)]) {
    if (ids.length && !ids.includes(item.id)) continue;
    registerSlot(slot, { ...item })();
    undo.push(() => registerSlot(slot, item));
  }
}

/** keel with only its core: no plugin's page, and no plugin's piece in any slot. */
export function coreOnly() {
  withoutPages(
    ...allPages()
      .map((p) => p.id)
      .filter((id) => !OWN.has(id)),
  );
  for (const slot of Object.values(SLOTS)) {
    const theirs = slotItems(slot).filter(
      (i) => !(slot === SLOTS.connectionsKind && i.id === "github"),
    );
    if (theirs.length) withoutSlot(slot, ...theirs.map((i) => i.id));
  }
}

/** Everything taken away comes back, in the order it was there. */
export function restorePlugins() {
  const all = undo;
  undo = [];
  for (const put of all) put();
}
