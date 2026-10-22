import { HISTORY_MAX } from "./types";
import { useCallback, useEffect, useState } from "react";
import type { KeelCore } from "../../core/keel";

/** 0.18.18 the person's earlier prompts, newest first: keel's (the project's KeelBot chats, they survive a restart and are
 *  the same on another computer), with what was sent here since on top; `hIdx`: the one shown while ↑ / ↓ walk them (-1: not
 *  walking). */
export function usePromptHistory(core: KeelCore, started: boolean, pidNow: string | null) {
  const [history, setHistory] = useState<string[]>([]);
  const [hIdx, setHIdx] = useState(-1);
  useEffect(() => {
    if (!started || !pidNow) return;
    let alive = true;
    void core.prompts().then((ps) => {
      if (!alive) return;
      setHistory((h) => [...new Set([...h.filter((x) => !ps.includes(x)), ...ps])].slice(0, HISTORY_MAX));
      setHIdx(-1);
    }).catch(() => undefined);
    return () => void (alive = false);
  }, [core, started, pidNow]);
  /** a prompt that was sent goes on top */
  const remember = useCallback((text: string) => setHistory((h) => [text, ...h.filter((x) => x !== text)].slice(0, HISTORY_MAX)), []);
  return { history, hIdx, setHIdx, remember };
}
