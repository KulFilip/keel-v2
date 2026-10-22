import { type Sel } from "./types";
import { useEffect, useRef, useState } from "react";

/** Select with the mouse and it is copied: the selection (`selRef` for handlers), and "copied N characters" for a few seconds. */
export function useSelection() {
  const [sel, setSelState] = useState<Sel | null>(null);
  const selRef = useRef<Sel | null>(null);
  const setSel = (x: Sel | null) => {
    selRef.current = x;
    setSelState(x);
  };
  const [flash, setFlashState] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setFlash = (x: string | null) => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = x ? setTimeout(() => setFlashState(null), 4000) : null;
    setFlashState(x);
  };
  useEffect(() => () => void (flashTimer.current && clearTimeout(flashTimer.current)), []);
  return { sel, selRef, setSel, flash, setFlash };
}
