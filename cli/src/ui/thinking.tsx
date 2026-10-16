// "Working" the Claude Code way, in keel's words: a small turning compass on the water, a keel verb that changes with
// each turn ("Charting…", "Sounding the depths…"), the seconds so far, the tokens so far, and how to stop it.
import React, { useEffect, useState } from "react";
import { Text } from "ink";
import { useTheme } from "./theme";
import * as fmt from "../core/format";

/** A compass that turns over a wave; ASCII: a turning bar over a wave. */
export const FRAMES = ["◜∼", "◝≈", "◞∼", "◟≈"];
export const FRAMES_ASCII = ["|~", "/=", "-~", "\\="];
export const VERBS = ["Charting", "Setting sail", "Trimming the sails", "Reading the currents", "Sounding the depths", "Plotting a course",
  "Hoisting", "Tacking", "Mooring", "Taking soundings", "Checking the keel", "Steering", "Casting off", "Reefing"];

/** A verb for one turn: random, or the same for the same seed (a call id), so one turn keeps its word. */
export function pickVerb(seed?: string | null, rand: () => number = Math.random): string {
  if (!seed) return VERBS[Math.floor(rand() * VERBS.length)];
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return VERBS[h % VERBS.length];
}

export const elapsed = (since: number | null | undefined, now: number) => (since ? Math.max(0, Math.floor((now - since) / 1000)) : 0);

export function Thinking({ verb, since, tokens, hint, who, interval = 80 }: {
  verb: string; since?: number | null; tokens?: number; hint?: string; who?: string; interval?: number;
}) {
  const t = useTheme();
  const frames = t.ascii ? FRAMES_ASCII : FRAMES;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), interval);
    return () => clearInterval(id);
  }, [interval]);
  const s = elapsed(since, Date.now());
  const bits = [`${s}s`, ...(tokens ? [`~${fmt.short(tokens)} tokens`] : []), ...(hint ? [hint] : [])];
  return (
    <Text>
      <Text color={t.color("accent")} bold>{frames[tick % frames.length]} </Text>
      {who ? <Text bold>{who} · </Text> : null}
      <Text color={t.color("accent")}>{verb}…</Text>
      <Text color={t.color("dim")}>{` (${bits.join(" · ")})`}</Text>
    </Text>
  );
}
