import { blockLines, startLines } from "../../core/lines";
import { useMemo, useRef } from "react";
import type { Paint } from "../../core/theme";
import type { Item } from "./types";

/** The full screen's transcript as lines (each block's lines kept until the width changes), and each line's item (a
 *  click on a tool call's line opens it). */
export function useTranscript(items: Item[], width: number, screen: boolean, paint: Paint) {
  // the full screen's transcript as lines (each block's lines kept until the width changes)
  const cache = useRef(new Map<number, { w: number; paint: unknown; lines: string[] }>());
  // each line's item (a click on a tool call's line opens it)
  const owners = useRef<number[]>([]);
  const lines = useMemo(() => {
    if (!screen) return [];
    const out: string[] = [];
    const own: number[] = [];
    for (const it of items) {
      let c = cache.current.get(it.id);
      if (!c || c.w !== width || c.paint !== paint) {
        c = { w: width, paint: paint, lines: it.kind === "start" ? startLines(it.s, width, paint) : [...(it.gap ? [""] : []), ...blockLines(it.b, width, paint)] };
        cache.current.set(it.id, c);
      }
      out.push(...c.lines);
      for (let k = 0; k < c.lines.length; k++) own.push(it.id);
    }
    owners.current = own;
    return out;
  }, [items, width, screen, paint]);
  return { cache, owners, lines };
}
