import { useRef, useState } from "react";
import type { Pending } from "./types";

/** What the app waits on (a pick or an ask), the picker's cursor and filter, and what is ticked in a pick of several. */
export function usePending() {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  pendingRef.current = pending;
  const [pickIdx, setPickIdx] = useState(0);
  const [pickFilter, setPickFilter] = useState("");
  // keel 0.18.9 a pick of several: what is ticked (Space), sent with Enter
  const [ticked, setTicked] = useState<Set<string>>(() => new Set());
  return { pending, setPending, pendingRef, pickIdx, setPickIdx, pickFilter, setPickFilter, ticked, setTicked };
}
