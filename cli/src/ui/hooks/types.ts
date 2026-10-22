// The types and constants of keel TUI's Ink app (App.tsx) that its hooks and views share.

import type { Block, PanelName, Pick, Ask } from "../../core/commands";
import type { PermissionQuestion, Snapshot } from "../../core/keel";
import type { ThemeName } from "../../core/theme";
import type { Point } from "../../core/select";

/** `gap`: an empty line above it (the first block of each answer, so answers stand apart; notices in a row stay together) */
export type Item = { id: number; kind: "start"; s: Snapshot } | { id: number; kind: "block"; b: Block; gap?: boolean };

/** `qid`: the KeelBot permission question this pick shows (it goes when the question ends elsewhere) */
export type Pending = { cmd: string; pick?: Pick; ask?: Ask; qid?: string };

export const CTRL_PANEL: Record<string, PanelName> = { f: "flow", a: "agents", n: "inbox" };
/** An open tool call in the live area shows at most this many of its last lines. */
export const LIVE_TOOL_ROWS = 12;
/** a plugin's mode without the full screen (--inline, tests): this many rows */
export const INLINE_MODE_ROWS = 20;
/** keel's panels, and a plugin's ("plugin:git") */
export type PanelId = PanelName | `plugin:${string}` | `job:${string}`;
export type Question = PermissionQuestion;
/** A selection with the mouse: in the transcript (`line` is the transcript's line) or in the prompt (line 0); `moved`
 *  once it covers more than the pressed cell (a plain click selects nothing). */
export type Sel = { area: "view" | "prompt"; a: Point; b: Point; moved: boolean };
/** 0.18.18 the prompt history keeps this many (as opencode's, MIT: the last 50) */
export const HISTORY_MAX = 50;
/** What /theme says after it changed the palette. */
export const THEME_WORDS: Record<ThemeName, string> = { keel: "keel's own colours (for a dark background)", dark: "colours for a dark background", light: "colours for a light background",
  auto: "colours that read on any background" };
/** two presses on the same cell within this many ms: a double-click (the word under it) */
export const DOUBLE_MS = 400;
